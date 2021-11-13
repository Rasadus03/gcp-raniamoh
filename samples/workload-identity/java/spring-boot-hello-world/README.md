# Kubernetes Hello World with Cloud Code

"Hello World" is a Kubernetes application that contains a single
[Deployment](https://kubernetes.io/docs/concepts/workloads/controllers/deployment/) and a corresponding
[Service](https://kubernetes.io/docs/concepts/services-networking/service/). The Deployment contains a web server that renders a simple webpage.

For details on how to use this sample as a template in Cloud Code, read the documentation for Cloud Code for [VS Code](https://cloud.google.com/code/docs/vscode/quickstart-local-dev?utm_source=ext&utm_medium=partner&utm_campaign=CDR_kri_gcp_cloudcodereadmes_012521&utm_content=-) or [IntelliJ](https://cloud.google.com/code/docs/intellij/quickstart-k8s?utm_source=ext&utm_medium=partner&utm_campaign=CDR_kri_gcp_cloudcodereadmes_012521&utm_content=-).

### Table of Contents
* [What's in this sample](#whats-in-this-sample)

---
## What's in this sample
### Kubernetes architecture
![Kubernetes Architecture Diagram](./img/diagram.png)

### Directory contents

- `skaffold.yaml` - A schema file that defines skaffold configurations ([skaffold.yaml reference](https://skaffold.dev/docs/references/yaml/))
- `kubernetes-manifests/` - Contains Kubernetes YAML files for the Guestbook services and deployments, including:

  - `hello.deployment.yaml` - deploys a pod with the 'java-hello-world' container image
  - `hello.service.yaml` - creates a load balancer and exposes the 'java-hello-world' service on an external IP in the cluster

---

### Setup of the workload identity for the app

- Run gcloud iam service-accounts create helloappgsac --project=raniamoh-playground
- Run gcloud iam service-accounts add-iam-policy-binding  helloappgsac@raniamoh-playground.iam.gserviceaccount.com  --role=roles/iam.workloadIdentityUser --member="serviceAccount:raniamoh-playground.svc.id.goog[wibasictest/helloappksac]"

kubectl annotate serviceaccount \
  --namespace wibasictest \
   helloappksac \
   iam.gke.io/gcp-service-account=app1-gsa@raniamoh-playground.iam.gserviceaccount.com




projects/-/serviceAccounts/helloappgsac@raniamoh-playground.iam.gserviceaccount.com



