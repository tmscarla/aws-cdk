import * as cloudwatch from '../../aws-cloudwatch';
import * as iam from '../../aws-iam';
import * as kms from '../../aws-kms';
import { Arn, ArnFormat, RemovalPolicy, Resource, Stack, Token } from '../../core';
import { Construct } from 'constructs';
import { DataProtectionPolicy } from './data-protection-policy';
import { LogStream } from './log-stream';
import { CfnLogGroup } from './logs.generated';
import { MetricFilter } from './metric-filter';
import { FilterPattern, IFilterPattern } from './pattern';
import { ResourcePolicy } from './policy';
import { ILogSubscriptionDestination, SubscriptionFilter } from './subscription-filter';

export interface ILogGroup extends iam.IResourceWithPolicy {
  /**
   * The ARN of this log group, with ':*' appended
   *
   * @attribute
   */
  readonly logGroupArn: string;

  /**
   * The name of this log group
   * @attribute
   */
  readonly logGroupName: string;

  /**
   * Create a new Log Stream for this Log Group
   *
   * @param id Unique identifier for the construct in its parent
   * @param props Properties for creating the LogStream
   */
  addStream(id: string, props?: StreamOptions): LogStream;

  /**
   * Create a new Subscription Filter on this Log Group
   *
   * @param id Unique identifier for the construct in its parent
   * @param props Properties for creating the SubscriptionFilter
   */
  addSubscriptionFilter(id: string, props: SubscriptionFilterOptions): SubscriptionFilter;

  /**
   * Create a new Metric Filter on this Log Group
   *
   * @param id Unique identifier for the construct in its parent
   * @param props Properties for creating the MetricFilter
   */
  addMetricFilter(id: string, props: MetricFilterOptions): MetricFilter;

  /**
   * Extract a metric from structured log events in the LogGroup
   *
   * Creates a MetricFilter on this LogGroup that will extract the value
   * of the indicated JSON field in all records where it occurs.
   *
   * The metric will be available in CloudWatch Metrics under the
   * indicated namespace and name.
   *
   * @param jsonField JSON field to extract (example: '$.myfield')
   * @param metricNamespace Namespace to emit the metric under
   * @param metricName Name to emit the metric under
   * @returns A Metric object representing the extracted metric
   */
  extractMetric(jsonField: string, metricNamespace: string, metricName: string): cloudwatch.Metric;

  /**
   * Give permissions to write to create and write to streams in this log group
   */
  grantWrite(grantee: iam.IGrantable): iam.Grant;

  /**
   * Give permissions to read from this log group and streams
   */
  grantRead(grantee: iam.IGrantable): iam.Grant;

  /**
   * Give the indicated permissions on this log group and all streams
   */
  grant(grantee: iam.IGrantable, ...actions: string[]): iam.Grant;

  /**
   * Public method to get the physical name of this log group
   */
  logGroupPhysicalName(): string;
}

/**
 * An CloudWatch Log Group
 */
abstract class LogGroupBase extends Resource implements ILogGroup {
  /**
   * The ARN of this log group, with ':*' appended
   */
  public abstract readonly logGroupArn: string;

  /**
   * The name of this log group
   */
  public abstract readonly logGroupName: string;


  private policy?: ResourcePolicy;

  /**
   * Create a new Log Stream for this Log Group
   *
   * @param id Unique identifier for the construct in its parent
   * @param props Properties for creating the LogStream
   */
  public addStream(id: string, props: StreamOptions = {}): LogStream {
    return new LogStream(this, id, {
      logGroup: this,
      ...props,
    });
  }

  /**
   * Create a new Subscription Filter on this Log Group
   *
   * @param id Unique identifier for the construct in its parent
   * @param props Properties for creating the SubscriptionFilter
   */
  public addSubscriptionFilter(id: string, props: SubscriptionFilterOptions): SubscriptionFilter {
    return new SubscriptionFilter(this, id, {
      logGroup: this,
      ...props,
    });
  }

  /**
   * Create a new Metric Filter on this Log Group
   *
   * @param id Unique identifier for the construct in its parent
   * @param props Properties for creating the MetricFilter
   */
  public addMetricFilter(id: string, props: MetricFilterOptions): MetricFilter {
    return new MetricFilter(this, id, {
      logGroup: this,
      ...props,
    });
  }

  /**
   * Extract a metric from structured log events in the LogGroup
   *
   * Creates a MetricFilter on this LogGroup that will extract the value
   * of the indicated JSON field in all records where it occurs.
   *
   * The metric will be available in CloudWatch Metrics under the
   * indicated namespace and name.
   *
   * @param jsonField JSON field to extract (example: '$.myfield')
   * @param metricNamespace Namespace to emit the metric under
   * @param metricName Name to emit the metric under
   * @returns A Metric object representing the extracted metric
   */
  public extractMetric(jsonField: string, metricNamespace: string, metricName: string) {
    new MetricFilter(this, `${metricNamespace}_${metricName}`, {
      logGroup: this,
      metricNamespace,
      metricName,
      filterPattern: FilterPattern.exists(jsonField),
      metricValue: jsonField,
    });

    return new cloudwatch.Metric({ metricName, namespace: metricNamespace }).attachTo(this);
  }

  /**
   * Give permissions to create and write to streams in this log group
   */
  public grantWrite(grantee: iam.IGrantable) {
    return this.grant(grantee, 'logs:CreateLogStream', 'logs:PutLogEvents');
  }

  /**
   * Give permissions to read and filter events from this log group
   */
  public grantRead(grantee: iam.IGrantable) {
    return this.grant(grantee,
      'logs:FilterLogEvents',
      'logs:GetLogEvents',
      'logs:GetLogGroupFields',
      'logs:DescribeLogGroups',
      'logs:DescribeLogStreams',
    );
  }

  /**
   * Give the indicated permissions on this log group and all streams
   */
  public grant(grantee: iam.IGrantable, ...actions: string[]) {
    return iam.Grant.addToPrincipalOrResource({
      grantee,
      actions,
      // A LogGroup ARN out of CloudFormation already includes a ':*' at the end to include the log streams under the group.
      // See https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-logs-loggroup.html#w2ab1c21c10c63c43c11
      resourceArns: [this.logGroupArn],
      resource: this,
    });
  }

  /**
   * Public method to get the physical name of this log group
   * @returns Physical name of log group
   */
  public logGroupPhysicalName(): string {
    return this.physicalName;
  }

  /**
   * Adds a statement to the resource policy associated with this log group.
   * A resource policy will be automatically created upon the first call to `addToResourcePolicy`.
   *
   * Any ARN Principals inside of the statement will be converted into AWS Account ID strings
   * because CloudWatch Logs Resource Policies do not accept ARN principals.
   *
   * @param statement The policy statement to add
   */
  public addToResourcePolicy(statement: iam.PolicyStatement): iam.AddToResourcePolicyResult {
    if (!this.policy) {
      this.policy = new ResourcePolicy(this, 'Policy');
    }
    this.policy.document.addStatements(statement.copy({
      principals: statement.principals.map(p => this.convertArnPrincpalToAccountId(p)),
    }));
    return { statementAdded: true, policyDependable: this.policy };
  }

  private convertArnPrincpalToAccountId(principal: iam.IPrincipal) {
    if (principal.principalAccount) {
      // we use ArnPrincipal here because the constructor inserts the argument
      // into the template without mutating it, which means that there is no
      // ARN created by this call.
      return new iam.ArnPrincipal(principal.principalAccount);
    }

    if (principal instanceof iam.ArnPrincipal) {
      const parsedArn = Arn.split(principal.arn, ArnFormat.SLASH_RESOURCE_NAME);
      if (parsedArn.account) {
        return new iam.ArnPrincipal(parsedArn.account);
      }
    }

    return principal;
  }
}

/**
 * How long, in days, the log contents will be retained.
 */
export enum RetentionDays {
  /**
   * 1 day
   */
  ONE_DAY = 1,

  /**
   * 3 days
   */
  THREE_DAYS = 3,

  /**
   * 5 days
   */
  FIVE_DAYS = 5,

  /**
   * 1 week
   */
  ONE_WEEK = 7,

  /**
   * 2 weeks
   */
  TWO_WEEKS = 14,

  /**
   * 1 month
   */
  ONE_MONTH = 30,

  /**
   * 2 months
   */
  TWO_MONTHS = 60,

  /**
   * 3 months
   */
  THREE_MONTHS = 90,

  /**
   * 4 months
   */
  FOUR_MONTHS = 120,

  /**
   * 5 months
   */
  FIVE_MONTHS = 150,

  /**
   * 6 months
   */
  SIX_MONTHS = 180,

  /**
   * 1 year
   */
  ONE_YEAR = 365,

  /**
   * 13 months
   */
  THIRTEEN_MONTHS = 400,

  /**
   * 18 months
   */
  EIGHTEEN_MONTHS = 545,

  /**
   * 2 years
   */
  TWO_YEARS = 731,

  /**
   * 3 years
   */
  THREE_YEARS = 1096,

  /**
   * 5 years
   */
  FIVE_YEARS = 1827,

  /**
   * 6 years
   */
  SIX_YEARS = 2192,

  /**
   * 7 years
   */
  SEVEN_YEARS = 2557,

  /**
   * 8 years
   */
  EIGHT_YEARS = 2922,

  /**
   * 9 years
   */
  NINE_YEARS = 3288,

  /**
   * 10 years
   */
  TEN_YEARS = 3653,

  /**
   * Retain logs forever
   */
  INFINITE = 9999,
}

/**
 * Properties for a LogGroup
 */
export interface LogGroupProps {
  /**
   * The KMS customer managed key to encrypt the log group with.
   *
   * @default Server-side encrpytion managed by the CloudWatch Logs service
   */
  readonly encryptionKey?: kms.IKey;

  /**
   * Name of the log group.
   *
   * @default Automatically generated
   */
  readonly logGroupName?: string;

  /**
   * Data Protection Policy for this log group.
   *
   * @default - no data protection policy
   */
  readonly dataProtectionPolicy?: DataProtectionPolicy;

  /**
   * How long, in days, the log contents will be retained.
   *
   * To retain all logs, set this value to RetentionDays.INFINITE.
   *
   * @default RetentionDays.TWO_YEARS
   */
  readonly retention?: RetentionDays;

  /**
   * Determine the removal policy of this log group.
   *
   * Normally you want to retain the log group so you can diagnose issues
   * from logs even after a deployment that no longer includes the log group.
   * In that case, use the normal date-based retention policy to age out your
   * logs.
   *
   * @default RemovalPolicy.Retain
   */
  readonly removalPolicy?: RemovalPolicy;
}

/**
 * Define a CloudWatch Log Group
 */
export class LogGroup extends LogGroupBase {
  /**
   * Import an existing LogGroup given its ARN
   */
  public static fromLogGroupArn(scope: Construct, id: string, logGroupArn: string): ILogGroup {
    const baseLogGroupArn = logGroupArn.replace(/:\*$/, '');

    class Import extends LogGroupBase {
      public readonly logGroupArn = `${baseLogGroupArn}:*`;
      public readonly logGroupName = Stack.of(scope).splitArn(baseLogGroupArn, ArnFormat.COLON_RESOURCE_NAME).resourceName!;
    }

    return new Import(scope, id, {
      environmentFromArn: baseLogGroupArn,
    });
  }

  /**
   * Import an existing LogGroup given its name
   */
  public static fromLogGroupName(scope: Construct, id: string, logGroupName: string): ILogGroup {
    const baseLogGroupName = logGroupName.replace(/:\*$/, '');

    class Import extends LogGroupBase {
      public readonly logGroupName = baseLogGroupName;
      public readonly logGroupArn = Stack.of(scope).formatArn({
        service: 'logs',
        resource: 'log-group',
        arnFormat: ArnFormat.COLON_RESOURCE_NAME,
        resourceName: baseLogGroupName + ':*',
      });
    }

    return new Import(scope, id);
  }

  /**
   * The ARN of this log group
   */
  public readonly logGroupArn: string;

  /**
   * The name of this log group
   */
  public readonly logGroupName: string;

  constructor(scope: Construct, id: string, props: LogGroupProps = {}) {
    super(scope, id, {
      physicalName: props.logGroupName,
    });

    let retentionInDays = props.retention;
    if (retentionInDays === undefined) { retentionInDays = RetentionDays.TWO_YEARS; }
    if (retentionInDays === Infinity || retentionInDays === RetentionDays.INFINITE) { retentionInDays = undefined; }

    if (retentionInDays !== undefined && !Token.isUnresolved(retentionInDays) && retentionInDays <= 0) {
      throw new Error(`retentionInDays must be positive, got ${retentionInDays}`);
    }

    const resource = new CfnLogGroup(this, 'Resource', {
      kmsKeyId: props.encryptionKey?.keyArn,
      logGroupName: this.physicalName,
      retentionInDays,
      dataProtectionPolicy: props.dataProtectionPolicy?._bind(this),
    });

    resource.applyRemovalPolicy(props.removalPolicy);

    this.logGroupArn = this.getResourceArnAttribute(resource.attrArn, {
      service: 'logs',
      resource: 'log-group',
      resourceName: this.physicalName,
      arnFormat: ArnFormat.COLON_RESOURCE_NAME,
    });
    this.logGroupName = this.getResourceNameAttribute(resource.ref);
  }
}

/**
 * Properties for a new LogStream created from a LogGroup
 */
export interface StreamOptions {
  /**
   * The name of the log stream to create.
   *
   * The name must be unique within the log group.
   *
   * @default Automatically generated
   */
  readonly logStreamName?: string;
}

/**
 * Properties for a new SubscriptionFilter created from a LogGroup
 */
export interface SubscriptionFilterOptions {
  /**
   * The destination to send the filtered events to.
   *
   * For example, a Kinesis stream or a Lambda function.
   */
  readonly destination: ILogSubscriptionDestination;

  /**
   * Log events matching this pattern will be sent to the destination.
   */
  readonly filterPattern: IFilterPattern;
}

/**
 * Properties for a MetricFilter created from a LogGroup
 */
export interface MetricFilterOptions {
  /**
   * Pattern to search for log events.
   */
  readonly filterPattern: IFilterPattern;

  /**
   * The namespace of the metric to emit.
   */
  readonly metricNamespace: string;

  /**
   * The name of the metric to emit.
   */
  readonly metricName: string;

  /**
   * The value to emit for the metric.
   *
   * Can either be a literal number (typically "1"), or the name of a field in the structure
   * to take the value from the matched event. If you are using a field value, the field
   * value must have been matched using the pattern.
   *
   * If you want to specify a field from a matched JSON structure, use '$.fieldName',
   * and make sure the field is in the pattern (if only as '$.fieldName = *').
   *
   * If you want to specify a field from a matched space-delimited structure,
   * use '$fieldName'.
   *
   * @default "1"
   */
  readonly metricValue?: string;

  /**
   * The value to emit if the pattern does not match a particular event.
   *
   * @default No metric emitted.
   */
  readonly defaultValue?: number;

  /**
   * The fields to use as dimensions for the metric. One metric filter can include as many as three dimensions.
   *
   * @see https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-properties-logs-metricfilter-metrictransformation.html#cfn-logs-metricfilter-metrictransformation-dimensions
   * @default - No dimensions attached to metrics.
   */
  readonly dimensions?: Record<string, string>;

  /**
   * The unit to assign to the metric.
   *
   * @see https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-properties-logs-metricfilter-metrictransformation.html#cfn-logs-metricfilter-metrictransformation-unit
   * @default - No unit attached to metrics.
   */
  readonly unit?: cloudwatch.Unit;
}
