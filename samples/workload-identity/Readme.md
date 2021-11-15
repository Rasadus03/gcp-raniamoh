<div align="center">

# This is a sample code to show how sts is used to get a JWT token when Workload Identity is enabled in GKE

</div>

## 1. Setup of GKE
### a) Create the K8s cluster enabling Workload Identity using terraform
Navigate to the tf-provision folder and update the params and run terraform apply

### b) Prepare Gke Cluster
#### i) Create the K8s namespace hosting the application
kubectl create namespace dotnetcore
kubectl create namespace javaspringboot
#### ii) Create the application SA in k8s
kubectl create serviceaccount --namespace dotnetcore app1_ksa
kubectl create serviceaccount --namespace javaspringboot app1_ksa
#### iii) Create the SA imporsenating workload SA with workload identity user 
gcloud iam service-accounts create workload-identity-user
gcloud iam service-accounts add-iam-policy-binding workload-identity-user@PROJECT_ID.iam.gserviceaccount.com --role roles/iam.workloadIdentityUser --member "serviceAccount:PROJECT_ID.svc.id.goog[dotnetcore/app1_ksa]"
gcloud iam service-accounts add-iam-policy-binding workload-identity-user@PROJECT_ID.iam.gserviceaccount.com --role roles/iam.workloadIdentityUser --member "serviceAccount:PROJECT_ID.svc.id.goog[javaspringboot/app1_ksa]"

Please make sure to update the PROJECT_ID with the gcp project id
#### iv) Create the app gsa
gcloud iam service-accounts create app1_gsa
gcloud iam service-accounts create app2_gsa

#### v) Link the ksa with the google SA by annotating the ksa
kubectl annotate serviceaccount --namespace dotnetcore app1_ksa iam.gke.io/gcp-service-account=app1_gsa@PROJECT_ID.iam.gserviceaccount.com
kubectl annotate serviceaccount --namespace javaspringboot app1_ksa iam.gke.io/gcp-service-account=app2_gsa@PROJECT_ID.iam.gserviceaccount.com

Please make sure to update the PROJECT_ID with the gcp project id

## 2. Deploy the .net core Application in dotnetcore namespace

## 3. Deploy the Java  Application in javaspringboot namespace


