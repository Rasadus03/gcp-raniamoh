SELECT
    DISTINCT jsonPayload.CONNECTION.dest_ip,
             jsonPayload.connection.dest_port,
             jsonPayload.connection.direction,
             jsonPayload.connection.protocol,
             jsonPayload.connection.src_ip,
             jsonPayload.src.instance AS `SRC_Instance`,
             jsonPayload.src.namespace AS `SRC_Namespace`,
             jsonPayload.src.pod_name AS `SRC_Pod_Name`,
             jsonPayload.src.pod_namespace AS `SRC_Pod_Namespace`,
             jsonPayload.src.workload_kind AS `SRC_Workload_Kind`,
             jsonPayload.src.workload_name AS `SRC_Workload_Name`,
             jsonPayload.dest.namespace AS `DEST_Namespace`,
             jsonPayload.dest.pod_name AS `DEST_Pod_Name`,
             jsonPayload.dest.pod_namespace AS `DEST_Pod_Namespace`,
             jsonPayload.dest.workload_kind AS `DEST_Workload_Kind`,
             jsonPayload.dest.workload_name AS `DEST_Workload_Name`
FROM
    `<PROJECT_ID>.<DATASET_NAME>.<POLICY_ACTIONS_LOG_NAME>`

