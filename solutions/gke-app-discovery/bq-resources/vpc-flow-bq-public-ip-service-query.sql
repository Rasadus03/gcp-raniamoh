SELECT jsonPayload.connection.*
FROM `<PROJECT_ID>.<DATASET_NAME>.<VPC_FLOW_LOG_NAME>`
WHERE jsonPayload.connection.dest_ip = "<PUBLIC_MANAGED_SERVICE_PUBLIC_IP>"