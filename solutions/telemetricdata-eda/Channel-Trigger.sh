gcloud eventarc triggers create hello-custom-events-trigger \
  --channel=$CHANNEL_NAME \
  --destination-run-service=$SERVICE_NAME \
  --destination-run-region=$REGION \
  --event-filters="type=mycompany.myorg.myproject.v1.myevent" \
  --event-filters="someattribute=somevalue" \
  --location=$REGION \
  --service-account=${PROJECT_NUMBER}-compute@developer.gserviceaccount.com

#  --service-account=workflow-sa@raniamoh-playground.iam.gserviceaccount.com\
  gcloud eventarc triggers create batch-processing \
  --channel=$CHANNEL_NAME \
  --location=us-central1 \
  --service-account=${PROJECT_NUMBER}-compute@developer.gserviceaccount.com \
  --destination-workflow=telemetric-data-processing \
  --destination-workflow-location=us-central1\
  --event-filters="type=telemetric.data"


  curl -H "Authorization: Bearer $(gcloud auth print-access-token)" \
    -H "Content-Type: application/json" \
    -X POST \
    -d '{
         "events": [
               {
                "@type": "type.googleapis.com/io.cloudevents.v1.CloudEvent",
                "attributes": {
                  "datacontenttype": {"ceString": "application/json"},
                  "someattribute": {"ceString": "somevalue"},
                  "time": {"ceTimestamp": "2022-03-19T21:29:13.899-04:00"},
                  "vehicleid":  {"ceString": "Vehicle913"},
                   "group":  {"ceString": "vehicles"},
                },
                "id": "00558614",
                "source": "//sensors/sensor870",
                "specVersion": "1.0",
                "textData": "{\"message\": \"The car is moving on the road\"}",
                "type": "telemetric.data"
              }
            ]
        }' \
    https://eventarcpublishing.googleapis.com/v1/projects/$PROJECT_ID/locations/$REGION/channels/$CHANNEL_NAME:publishEvents


 export GOOGLE_APPLICATION_CREDENTIALS='/Users/raniamoh/my-playground/telemetricdata-eda/telemetric-sa.json'

 CHANNEL_NAME=telemetry-channel
REGION=us-central1
PROJECT_ID=$(gcloud config get-value project)
export JAVA_HOME="/usr/libexec/java_home -V 17.0.5"
 ./gradlew run  --args="$PROJECT_ID $REGION $CHANNEL_NAME"
 gcloud eventarc triggers create batch-processing   --channel=$CHANNEL_NAME   --location=us-central1   --service-account=workflow-sa@raniamoh-playground.iam.gserviceaccount.com  --destination-workflow=telemetric-data-processing   --destination-workflow-location=us-central1

 gcloud eventarc triggers create batch-processing   --channel=$CHANNEL_NAME   --location=us-central1   --service-account=workflow-sa@raniamoh-playground.iam.gserviceaccount.com  --destination-workflow=telemetric-data-processing   --destination-workflow-location=us-central1  --event-filters="type=telemetric.data"   --event-filters="group=vehicles"



 {
   "data": {
     "message": "The car is moving on the road"
   },
   "datacontenttype": "application/json",
   "group": "vehicles",
   "id": "96873",
   "source": "//sensors/sensor8652",
   "specversion": "1.0",
   "time": "2022-12-27T19:51:20.383Z",
   "type": "telemetric.data",
   "vehicleid": "Vehicle4914"
 }

 gcloud compute instances create telemetry-edge --project=raniamoh-playground --zone=europe-west4-a --machine-type=e2-standard-2 --network-interface=network-tier=PREMIUM,subnet=default --metadata=startup-script=set\ -e$'\n'set\ -v$'\n'$'\n'\#\ Talk\ to\ the\ metadata\ server\ to\ get\ the\ project\ id$'\n'PROJECTID=\$\(curl\ -s\ \"http://metadata.google.internal/computeMetadata/v1/project/project-id\"\ -H\ \"Metadata-Flavor:\ Google\"\)$'\n'$'\n'echo\ \"Project\ ID:\ \$\{PROJECTID\}\"$'\n'$'\n'\#\ Install\ dependencies\ from\ apt$'\n'apt-get\ install\ -yq\ openjdk-11-jdk\ git\ maven$'\n'$'\n'mvn\ --version$'\n'$'\n'\#\ Clone\ the\ source\ repository.$'\n'git\ clone\ https://github.com/Rasadus03/gcp-raniamoh.git,enable-oslogin=true --maintenance-policy=MIGRATE --provisioning-model=STANDARD --service-account=189908348872-compute@developer.gserviceaccount.com --scopes=https://www.googleapis.com/auth/devstorage.read_only,https://www.googleapis.com/auth/logging.write,https://www.googleapis.com/auth/monitoring.write,https://www.googleapis.com/auth/servicecontrol,https://www.googleapis.com/auth/service.management.readonly,https://www.googleapis.com/auth/trace.append --create-disk=auto-delete=yes,boot=yes,device-name=telemetry-edge,image=projects/debian-cloud/global/images/debian-11-bullseye-v20221206,mode=rw,size=10,type=projects/raniamoh-playground/zones/us-central1-a/diskTypes/pd-balanced --no-shielded-secure-boot --shielded-vtpm --shielded-integrity-monitoring --reservation-affinity=any