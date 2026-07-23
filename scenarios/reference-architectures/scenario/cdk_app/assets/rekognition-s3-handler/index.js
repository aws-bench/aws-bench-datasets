const { Rekognition } = require('@aws-sdk/client-rekognition');
const { DynamoDB } = require('@aws-sdk/client-dynamodb');
const client = new Rekognition({});

exports.handler = async (event) => {
    const key = event.Records[0].s3.object.key;
    console.log(key);

    const params = {
        Image: {
            S3Object: {
                Bucket: process.env.BUCKET_NAME,
                Name: key
            },
        },
        MaxLabels: 10,
        MinConfidence: 70
    };

    const response = await client.detectLabels(params);
    const labels = response.Labels || [];
    console.log(labels.map(i => i.Name).toString());

    const tableName = process.env.TABLE_NAME || "";
    const dynamodb = new DynamoDB({});

    const dynamodbParams = {
        TableName: tableName,
        Item: {
            image_name: {'S': key},
            labels: {'S': labels.map(i => i.Name).toString()}
        },
        ConditionExpression: 'attribute_not_exists(image_name)'
    };

    try {
        await dynamodb.putItem(dynamodbParams);
    }
    catch(err) {
        console.log(err);
    }

    return;
};
