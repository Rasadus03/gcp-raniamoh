### This is a Solution to implement  processing of the Telemetry data  using event arc
#### The solution consists of the components shown in the following diagram:
![solution high level blueprint](Telemetric-data-processing.png)
Here are the guidelines for implementing the solution in your GCP environment:

**Note: Please replace Hosting_Project_ID **

1. Create EventArc custom channel  by running the following commands:
   - Enable all required APIs:
``` gcloud services enable  \
    eventarc.googleapis.com \
    eventarcpublishing.googleapis.com \
    workflows.googleapis.com
   ```
- Create the telemetry-channel custom event channel
```
    cloud eventarc channels create 
```
2. Create workflow "telemetric-data-processing" using the following command:
- Create workflow service account:
```
    gcloud iam service-accounts create  workflow-sa
```
- Grant access to the workflow sa:
```
    #replace PROJECT_ID with the project id
    gcloud projects add-iam-policy-binding PROJECT_ID \
    --member "serviceAccount:workflow-sa@PROJECT_ID.iam.gserviceaccount.com" \
    --role "roles/logging.logWriter"
    
    gcloud projects add-iam-policy-binding PROJECT_ID \
    --member "serviceAccount:workflow-sa@PROJECT_ID.iam.gserviceaccount.com" \
    --role "roles/pubsub.subscriber"
```
- Create the workflow telemetric-data-processing:
```
   gcloud workflows deploy telemetric-data-processing --source=telemetric-data-processing.yaml \
    --service-account=workflow-sa@PROJECT_ID.iam.gserviceaccount.com
```
3. Create the "batck-processing-telemetricdata" workflow which log every 10 messages:
- Create the worklow:
```
   gcloud workflows deploy batck-processing-telemetricdata --source=batck-processing-telemetricdata.yaml \
    --service-account=workflow-sa@PROJECT_ID.iam.gserviceaccount.com
```
4. Create a new VM named "telemetry-edge" as e2 standard-2 with the  ***[vm-startup.sh](vm-startup.sh)*** as the startup script
5. Run the publish by 