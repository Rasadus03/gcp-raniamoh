/*
 * Copyright 2022 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// [START eventarc_custom_publish_java]
package com.google.systemofrecords.events.controllers;

import com.google.cloud.eventarc.publishing.v1.PublishEventsRequest;
import com.google.cloud.eventarc.publishing.v1.PublishEventsResponse;
import com.google.cloud.eventarc.publishing.v1.PublisherClient;
import com.google.gson.Gson;
import com.google.protobuf.Any;
import com.google.protobuf.util.Timestamps;
import com.google.systemofrecords.events.model.TelemetricDataEvent;
import com.google.systemofrecords.events.utils.EventBuilder;
import com.google.systemofrecords.events.utils.LogUtils;
import io.cloudevents.v1.proto.CloudEvent;
import io.cloudevents.v1.proto.CloudEvent.CloudEventAttributeValue;
import java.util.Date;
import java.util.Random;
import java.util.UUID;


public class PulishTelemetricEvent {
private Random rand = new Random();

  public void SendPublishEvent(String projectId, String region, String channel) {
    String vehicle = "Vehicle" +rand.nextLong(10000);
    String source = "//sensors/sensor" +rand.nextLong(10000);
    String type = "telemetric.data";
    String details = "The car is moving on the road";
    Date eventTime = new Date();

    TelemetricDataEvent telemetricDataEvent = new TelemetricDataEvent(eventTime, type, vehicle,
        source, details);

    LogUtils.info(PulishTelemetricEvent.class, "Building Telemetric Data Event!!!");

    LogUtils.info(PulishTelemetricEvent.class,
        String.format("Starting to publish message to channel %s", channel));

    PublishEventsRequest request = PublishEventsRequest.newBuilder()
        .setChannel("projects/" + projectId + "/locations/" + region + "/channels/" + channel)
        .addEvents(EventBuilder.generateTelemetricDataEvent(telemetricDataEvent))
        .build();
    try {
      // Create a client with credentials provided by the system.
      PublisherClient client = PublisherClient.create();
      PublishEventsResponse response = client.publishEvents(request);
      LogUtils.info(PulishTelemetricEvent.class,
          String.format("Message published successfully.\nReceived response: %s",
              response.toString()));
    } catch (Exception ex) {
      LogUtils.error(PulishTelemetricEvent.class, "An exception occurred while publishing" + ex);
    }
  }

  public static void main(String[] args) {
    String projectId = args[0];
    String region = args[1];
    String channel = args[2];
    System.out.println("ProjectId: " + projectId + " Region: " + region + " Channel: " + channel);

    new PulishTelemetricEvent().SendPublishEvent(projectId, region, channel);
    System.exit(0);
  }
}
