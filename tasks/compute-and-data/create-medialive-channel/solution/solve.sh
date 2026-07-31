#!/bin/bash
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
ROLE_NAME="${MEDIALIVE_ROLE_NAME:-MediaLiveAccessRole}"
OUT=/logs/agent/agent-output.txt
OUT_JSON=/logs/agent/agent-output.json

aws iam create-role \
  --role-name "$ROLE_NAME" \
  --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"medialive.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
aws iam attach-role-policy --role-name "$ROLE_NAME" --policy-arn arn:aws:iam::aws:policy/AmazonS3FullAccess
aws iam attach-role-policy --role-name "$ROLE_NAME" --policy-arn arn:aws:iam::aws:policy/CloudWatchLogsFullAccess
ROLE_ARN=$(aws iam get-role --role-name "$ROLE_NAME" --query 'Role.Arn' --output text)
sleep 15

SG_ID=$(aws medialive create-input-security-group --whitelist-rules '[{"Cidr":"0.0.0.0/0"}]' --region "$REGION" --query 'SecurityGroup.Id' --output text)
INPUT_ID=$(aws medialive create-input \
  --name "MyRTMPInput" \
  --type RTMP_PUSH \
  --destinations '[{"StreamName":"live/stream1"},{"StreamName":"live/stream2"}]' \
  --input-security-groups "[\"$SG_ID\"]" \
  --region "$REGION" --query 'Input.Id' --output text)

CHANNEL_ID=$(aws medialive create-channel \
  --name "MyMediaLiveChannel" \
  --role-arn "$ROLE_ARN" \
  --channel-class STANDARD \
  --input-attachments "[{\"InputId\":\"$INPUT_ID\",\"InputAttachmentName\":\"MyRTMPInputAttachment\",\"InputSettings\":{\"SourceEndBehavior\":\"CONTINUE\",\"InputFilter\":\"AUTO\",\"FilterStrength\":1,\"DeblockFilter\":\"DISABLED\",\"DenoiseFilter\":\"DISABLED\",\"AudioSelectors\":[],\"CaptionSelectors\":[]}}]" \
  --destinations '[{"Id":"destination1","Settings":[{"Url":"s3://mybucket-medialive-output/stream1/index"},{"Url":"s3://mybucket-medialive-output/stream2/index"}]}]' \
  --encoder-settings '{"AudioDescriptions":[{"AudioSelectorName":"Default","CodecSettings":{"AacSettings":{"Bitrate":192000,"CodingMode":"CODING_MODE_2_0","InputType":"NORMAL","Profile":"LC","RateControlMode":"CBR","RawFormat":"NONE","SampleRate":48000,"Spec":"MPEG4"}},"Name":"audio_1"}],"OutputGroups":[{"Name":"HLS_Group","OutputGroupSettings":{"HlsGroupSettings":{"Destination":{"DestinationRefId":"destination1"},"HlsCdnSettings":{"HlsBasicPutSettings":{"ConnectionRetryInterval":30,"FilecacheDuration":300,"NumRetries":5,"RestartDelay":15}},"InputLossAction":"EMIT_OUTPUT","ManifestCompression":"NONE","ManifestDurationFormat":"FLOATING_POINT","Mode":"LIVE","OutputSelection":"MANIFESTS_AND_SEGMENTS","ProgramDateTime":"EXCLUDE","SegmentLength":6,"StreamInfResolution":"INCLUDE","TimedMetadataId3Frame":"PRIV","TimedMetadataId3Period":10,"TsFileMode":"SEGMENTED_FILES"}},"Outputs":[{"AudioDescriptionNames":["audio_1"],"OutputName":"output_1","OutputSettings":{"HlsOutputSettings":{"HlsSettings":{"StandardHlsSettings":{"AudioRenditionSets":"program_audio","M3u8Settings":{"AudioFramesPerPes":4,"AudioPids":"492-498","EcmPid":"8182","PcrControl":"PCR_EVERY_PES_PACKET","PmtPid":"480","ProgramNum":1,"Scte35Pid":"500","Scte35Behavior":"NO_PASSTHROUGH","TimedMetadataBehavior":"NO_PASSTHROUGH","TimedMetadataPid":"502","VideoPid":"481"}}},"NameModifier":"_1"}},"VideoDescriptionName":"video_1"}]}],"TimecodeConfig":{"Source":"EMBEDDED"},"VideoDescriptions":[{"CodecSettings":{"H264Settings":{"AdaptiveQuantization":"HIGH","AfdSignaling":"NONE","Bitrate":5000000,"ColorMetadata":"INSERT","EntropyEncoding":"CABAC","FlickerAq":"ENABLED","FramerateControl":"INITIALIZE_FROM_SOURCE","GopBReference":"ENABLED","GopClosedCadence":1,"GopNumBFrames":2,"GopSize":90,"GopSizeUnits":"FRAMES","Level":"H264_LEVEL_AUTO","LookAheadRateControl":"HIGH","NumRefFrames":1,"ParControl":"INITIALIZE_FROM_SOURCE","Profile":"HIGH","RateControlMode":"CBR","ScanType":"PROGRESSIVE","SceneChangeDetect":"ENABLED","SpatialAq":"ENABLED","SubgopLength":"FIXED","Syntax":"DEFAULT","TemporalAq":"ENABLED","TimecodeInsertion":"DISABLED"}},"Height":1080,"Name":"video_1","RespondToAfd":"NONE","ScalingBehavior":"DEFAULT","Sharpness":50,"Width":1920}]}' \
  --region "$REGION" --query 'Channel.Id' --output text)

mkdir -p "$(dirname "$OUT")"
printf '{"ChannelId": "%s"}\n' "$CHANNEL_ID" > "$OUT_JSON"
echo "Done." > "$OUT"
