### This is a Solution to implement  custom error pages for GKE Gateway API workloads
#### The solution consists of the components shown in the following diagram:
![solution high level blueprint](imgs/Gke-Gateway-custom-error-page.png)
Here are the guidelines for implementing the solution in your GCP environment:

**Note: Please replace**

**- PROJECT_D with your project id**

**- NETWORK_URL with your network URL in the form of "projects/PROJECT_ID/global/networks/NETWORK_NAME"**

**- SUBNETWORK_URL with your subnetwork URL in the form of "projects/PROJECT_ID/regions/europe-west1/subnetworks/SUBNETWORK_NAME"**

**- WORKLOAD_IDENTITY_POOL_ID with the workload identity pool id, should be in the format of PROJECT_ID.svc.id.goog**

**- FLEET_NAME with the fleet project ID w**

1. Deploy Store application:
   - Enable all required APIs:
``` 
    gcloud services enable  \
    container.googleapis.com
   ```
-  Create a cluster with 
```
    gcloud beta container --project PROJECT_ID clusters create "application-cluster" \
      --gateway-api=standard \
      --zone "europe-west1-b" --no-enable-basic-auth --cluster-version "1.30.3-gke.1639000" \
      --release-channel "regular" --machine-type "e2-standard-4" --image-type "COS_CONTAINERD" \
      --disk-type "pd-balanced" --disk-size "100" --metadata disable-legacy-endpoints=true \
      --scopes "https://www.googleapis.com/auth/devstorage.read_only","https://www.googleapis.com/auth/logging.write","https://www.googleapis.com/auth/monitoring","https://www.googleapis.com/auth/servicecontrol","https://www.googleapis.com/auth/service.management.readonly","https://www.googleapis.com/auth/trace.append" \
      --num-nodes "1" --logging=SYSTEM,WORKLOAD,API_SERVER,SCHEDULER,CONTROLLER_MANAGER \
      --monitoring=SYSTEM,API_SERVER,SCHEDULER,CONTROLLER_MANAGER,STORAGE,POD,DEPLOYMENT,STATEFULSET,DAEMONSET,HPA,CADVISOR,KUBELET \
      --enable-ip-alias --network NETWORK_URL \
      --subnetwork SUBNETWORK_URL \
       --no-enable-intra-node-visibility --default-max-pods-per-node "110" \
       --security-posture=standard --workload-vulnerability-scanning=enterprise \
       --no-enable-master-authorized-networks \
       --addons HorizontalPodAutoscaling,HttpLoadBalancing,GcePersistentDiskCsiDriver \
       --enable-autoupgrade --enable-autorepair --max-surge-upgrade 1 --max-unavailable-upgrade 0 \
       --binauthz-evaluation-mode=DISABLED --enable-managed-prometheus \
       --workload-pool WORKLOAD_IDENTITY_POOL_ID \
       --enable-shielded-nodes --fleet-project=FLEET_NAME --node-locations "europe-west1-b"
```
2. Deploy 2 apps:
- Deploy the store app:
```
    gcloud container clusters get-credentials application-cluster --zone europe-west1-b --project PROJECT_ID
    
    kubectl apply -f https://raw.githubusercontent.com/GoogleCloudPlatform/gke-networking-recipes/main/gateway/gke-gateway-controller/app/store.yaml
```
- Deploy the error-app app which generates 404 error in some cases:

**Please replace PROJECT_ID with your project Id and ARTIFACT_REPOSITRY_NAME with the artifact registry docker repo name in the cloudbuild.yaml and error-app.yaml**

```
     cd src/error-app
     
     gcloud builds submit --region=europe-west4 --config cloudbuild.yaml
     
      kubectl apply -f ../../resources/error-app.yaml 
```

3. Create the GKE Gateway:
```
   kubectl apply -f ../../resources/gateway.yaml 
```
Check "kubectl get gateway" to get the newly created gateway Address --> GATEWAY_IP.
5. Create the HTTP Route for both applications:
```
   kubectl apply -f ../../resources/http-route.yaml
   
```
6.  Create a custom HTML Pages for all errors to the application and uploading the 3 custom HTMLs:
- Create the bucket:
```
   gsutil mb -c standard -l europe-west4 gs://custom-html
```
- Make the bucket public:
```
   gsutil iam ch allUsers:objectViewer gs://custom-html 
```
- Upload the 3 HTML files:
```
   gsutil cp ./src/custom-error-pages/* gs://custom-html
```
7. Create a Global load balancer infront of the GKE Gateway to handle all errors:
- Create a load balancer following the below flow:
![GLB Creation wizard](imgs/glb-flow-1.png)
![GLB Creation wizard](imgs/glb-flow-2.png)
![GLB Creation wizard](imgs/glb-flow-3.png)
![GLB Creation wizard](imgs/glb-flow-4.png)
![GLB Creation wizard](imgs/glb-flow-5.png)
- Configure the Frontend and backend service and URL Map following the below flo:
  ![GLB Creation wizard](imgs/glb-config-1.png)
- ![GLB Creation wizard](imgs/glb-config-2.png)
- ![GLB Creation wizard](imgs/glb-config-3.png)
- ![GLB Creation wizard](imgs/glb-config-4.png)
- ![GLB Creation wizard](imgs/glb-config-5.png)
- ![GLB Creation wizard](imgs/glb-config-6.png)
- ![GLB Creation wizard](imgs/glb-config-7.png)
- ![GLB Creation wizard](imgs/glb-config-8.png)
8. Wait till the GLB is availbe and test the load balancer using its External IP -->EXTERNAL_IP:
 - http://EXTERNAL_IP/ --> it routes to the GKE Gateway http route this is the default store app
 - http://EXTERNAL_IP/de --> it routes to the GKE Gateway http route this is the default store app with german version
 - http://EXTERNAL_IP/error-app?generateError=404 --> it routes to the GKE Gateway http route this is the error app and it generates HTTP 404 error and the LB runs the custom error page configurations
   ![errorpage](imgs/404.png)
 - http://EXTERNAL_IP/error-app?generateError=403 --> it routes to the GKE Gateway http route this is the error app and it generates HTTP 403 error nd the LB runs the custom error page configurations
   ![errorpage](imgs/403.png) 
 - http://EXTERNAL_IP/error-app?generateError=5xx --> it routes to the GKE Gateway http route this is the error app and it generates HTTP 5xx error nd the LB runs the custom error page configurations
   ![errorpage](imgs/5xx.png)
