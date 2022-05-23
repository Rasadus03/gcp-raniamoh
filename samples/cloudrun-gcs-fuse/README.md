# Cloud Run gcs fuse for pdf files

This sample shows how to create a service that uses gcs fuse to mount a gcs bucket and display/list all its content and read content of a pdf file.

## Tutorials
See our  [Using Cloud Storage FUSE with Cloud Run tutorial](https://cloud.google.com/run/docs/tutorials/network-filesystems-fuse) for instructions for setting up and deploying this sample application.

[create]: https://cloud.google.com/storage/docs/creating-buckets
[fuse]: https://cloud.google.com/storage/docs/gcs-fuse
[git]: https://github.com/GoogleCloudPlatform/gcsfuse
[auth]: https://cloud.google.com/artifact-registry/docs/docker/authentication


## How to run?

1. mvn clean install
2. Create Service account with Object View access
   ``` gcloud iam service-accounts create fs-identity ```
   ``` gcloud projects add-iam-policy-binding PROJECT_ID \
     --member "serviceAccount:fs-identity@PROJECT_ID.iam.gserviceaccount.com" \
     --role "roles/storage.objectViewer" ```
3. You can either deploy for the docker or source, to deploy from source directly:

   ``` rm Dockerfile ```
   ``` cp gcsfuse.Dockerfile Dockerfile ```
   ``` gcloud beta run deploy  secure-pdf-gcs --source . \ ```
   ``` --execution-environment gen2 \ ```
   ``` --allow-unauthenticated \ ```
   ``` --service-account fs-identity \ ```
   ``` --update-env-vars BUCKET=BUCKET_NAME ```
