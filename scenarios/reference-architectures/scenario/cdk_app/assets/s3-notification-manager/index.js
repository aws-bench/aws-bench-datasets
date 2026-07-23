const { S3Client, GetBucketNotificationConfigurationCommand, PutBucketNotificationConfigurationCommand } = require("@aws-sdk/client-s3");
const s3Client = new S3Client({ region: process.env.AWS_REGION });

exports.handler = async function (event, context) {
    console.log(event.RequestId, event.StackId, event.LogicalResourceId, JSON.stringify(event, undefined, 2));
    try {
        const props = event.ResourceProperties;
        const getParams = {
            Bucket: props.BucketName
        };
        const getBucketNotConfig = new GetBucketNotificationConfigurationCommand(getParams);
        const currentConfiguration = await s3Client.send(getBucketNotConfig);
        const mergedConfiguration = mergeConfigurations(event.RequestType, props.NotificationConfiguration, currentConfiguration);
        const putParams = {
            Bucket: props.BucketName,
            NotificationConfiguration: mergedConfiguration
        };
        console.log(event.RequestId, event.StackId, event.LogicalResourceId, {
            bucket: props.BucketName,
            previousConfiguration: JSON.stringify(currentConfiguration),
            newConfiguration: JSON.stringify(mergedConfiguration)
        });
        const putBucketNotificationCommand = new PutBucketNotificationConfigurationCommand(putParams);
        await s3Client.send(putBucketNotificationCommand);
        return { PhysicalResourceId: event.PhysicalResourceId || event.LogicalResourceId };
    } catch (e) {
        console.error(event.RequestId, event.StackId, event.LogicalResourceId, e);
        throw new Error(e.message + "\nMore information in CloudWatch Log Stream: " + context.logStreamName);
    }

    function mergeConfigurations(request, inputConfig, currentConfig) {
        const mergedConfig = {};
        for (const [key, value] of Object.entries(currentConfig)) {
            mergedConfig[key] = value;
            const input = inputConfig[key];
            if (input && input.length) {
                const inputIds = new Set(input.map(function(obj) { return obj.Id; }));
                if (request === "Delete") {
                    mergedConfig[key] = value.filter(function(obj) { return !inputIds.has(obj.Id); });
                } else {
                    const filterConfig = value.filter(function(obj) { return !inputIds.has(obj.Id); });
                    mergedConfig[key] = filterConfig.concat(input);
                }
            }
        }
        return mergedConfig;
    }
};
