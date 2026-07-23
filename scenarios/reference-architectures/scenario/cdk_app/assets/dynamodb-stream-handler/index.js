const { SNSClient, PublishCommand } = require("@aws-sdk/client-sns");
const snsClient = new SNSClient();
exports.handler = async (event) => {
    try {
        for (const record of event.Records) {
            if (record.eventName === "MODIFY") {
                const newImage = record.dynamodb.NewImage;
                const oldImage = record.dynamodb.OldImage;
                const newCount = newImage.count ? parseInt(newImage.count.N) : null;
                const oldCount = oldImage && oldImage.count ? parseInt(oldImage.count.N) : null;
                if (newCount === 0 && oldCount > 0) {
                    const itemName = newImage.itemName ? newImage.itemName.S : "Unknown item";
                    const params = {
                        Message: "Alert: " + itemName + " has reached zero inventory! Previous count was " + oldCount + ".",
                        Subject: "Stock Alert - " + itemName + " Out of Stock",
                        TopicArn: process.env.SNS_TOPIC_ARN
                    };
                    await snsClient.send(new PublishCommand(params));
                    console.log("Notification sent for " + itemName + " - count dropped to 0 from " + oldCount);
                }
            }
        }
        return { statusCode: 200, body: "Processing complete." };
    } catch (error) {
        console.error("Error processing records:", error);
        throw error;
    }
};
