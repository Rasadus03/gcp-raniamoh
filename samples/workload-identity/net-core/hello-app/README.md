# CloudDemo.MvcCore

`CloudDemo.MvcCore` is a lightweight sample application to display the jwt token using workload identity.

## Prerequisites

To build the application, you'll need

* Visual Studio 2019 _or_ the .NET Core SDK
* Docker

Instead of running the steps on your local workstations, you can also use Cloud Shell, which has
these components preinstalled.

### Build a Linux Docker image

1. Open a developer command prompt 
1. Switch to the `netcore` directory:

    `cd netcore`

1. Build and publish the solution:

    `dotnet publish -c Release -f netcoreapp3.1`

1. Build a Docker image, using the binaries published to the output folder:

    `docker build -t clouddemo-netcore .`

## Run the container locally

1. Run the container:

    `docker run --rm -it -p 8080:8080 clouddemo-netcore`

1. Point your web browser to http://localhost:8080/ and verify that the application is 
   working properly.

## Publish the Docker image

1. Tag and push the image:

    `docker tag xxxx-docker.pkg.dev/xxxxx/xxxx/clouddemo-netcore`

1. Push the image to Container Registry:

    `docker push xxxxx-docker.pkg.dev/xxx/xxx/clouddemo-netcore`

## Deploy to Kubernetes Engine

1. Create a Kubernetes deployment that uses the Docker image:

    kubectl apply -f deployment.yaml`
