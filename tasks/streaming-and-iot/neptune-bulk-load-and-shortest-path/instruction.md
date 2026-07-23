Bulk-load the social graph at `s3://{{streaming-and-iot-neptune-npt5d8h2v-us-east-1-LoaderBucketName}}/graph/` (vertices.csv + edges.csv) into Neptune cluster `{{streaming-and-iot-neptune-npt5d8h2v-us-east-1-NeptuneClusterId}}` and report the shortest path between users `alice` and `eve` (length in edges).

The Neptune data API is reachable only from inside the cluster's VPC. A bridge Lambda `{{streaming-and-iot-neptune-npt5d8h2v-us-east-1-BridgeLambdaName}}` is pre-deployed there; invoke it via `lambda.invoke(InvocationType='RequestResponse', Payload=...)` with a JSON `action` field. The loader expects IAM role `{{streaming-and-iot-neptune-npt5d8h2v-us-east-1-LoaderRoleArn}}` (already cluster-associated). Available actions:

| action | input | returns |
|---|---|---|
| `engine_status` | -- | `{ok, result}` |
| `start_loader` | `source`, `iam_role_arn`, `format` (default csv), optional `mode`/`parallelism`/`fail_on_error` | `{ok, http_status, body}` (body has `payload.loadId` on success) |
| `loader_status` | `load_id` | `{ok, result}` (full GetLoaderJobStatus) |
| `list_loader_jobs` | -- | `{ok, result}` |
| `vertex_count` | -- | `{ok, count}` |
| `edge_count` | -- | `{ok, count}` |
| `shortest_path` | `from`, `to` | `{ok, path_length}` (edges; `null` if unreachable) |

IMPORTANT: Write your final prose answer to `/logs/agent/agent-output.txt`.

Additionally, write `/logs/agent/agent-output.json` containing exactly:

```json
{
  "load_id": "the loadId returned by start_loader",
  "path_length": "<shortest path length in edges>"
}
```
