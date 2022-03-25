SELECT DISTINCT flow_logs.jsonPayload.src_gke_details.pod.pod_namespace  AS `Source_Pod_Namespace`,
                flow_logs.jsonPayload.src_gke_details.pod.pod_name       AS `Source_App_Name`,
                flow_logs.jsonPayload.dest_gke_details.pod.pod_namespace AS `Destination_namespace`,
                flow_logs.jsonPayload.dest_gke_details.pod.pod_name      AS `Destination_App_Name`
FROM `<PROJECT_ID>.<DATASET_NAME>.<VPC_FLOW_LOG_NAME>` AS flow_logs
WHERE flow_logs.jsonPayload.src_gke_details.pod.pod_name IS NOT NULL
  AND flow_logs.jsonPayload.dest_gke_details.pod.pod_name IS NOT NULL