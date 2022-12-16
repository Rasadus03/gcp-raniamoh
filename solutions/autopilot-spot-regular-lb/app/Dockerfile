# Use the official maven/Java 8 image to create a build artifact.
# https://hub.docker.com/_/maven
FROM maven:3.8.6-openjdk-18 as builder

# Copy local code to the container image.
WORKDIR /app
COPY pom.xml ./
COPY  src  ./src/

# Build a release artifact.
RUN mvn  clean install

# Use AdoptOpenJDK for base image.
# It's important to use OpenJDK 8u191 or above that has container support enabled.
# https://hub.docker.com/r/adoptopenjdk/openjdk8
# https://docs.docker.com/develop/develop-images/multistage-build/#use-multi-stage-builds
#FROM arm64v8/openjdk
FROM  khipu/openjdk17-alpine
# Copy the jar to the production image from the builder stage.
COPY --from=builder /app/target/webapp-*.jar /webapp.jar

# Run the web service on container startup.
#CMD ["java","-Djava.security.egd=file:/dev/./urandom","-Dserver.port=8080","-jar","/sample-app.jar"]
CMD ["java","-Djava.security.egd=file:/dev/./urandom","-Dserver.port=${PORT}","-jar","/webapp.jar","--name=${APP_NAME}"]
