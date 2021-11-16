
package com.gcp.sample.token.web;

import com.google.api.gax.core.FixedCredentialsProvider;
import com.google.auth.oauth2.ComputeEngineCredentials;
import com.google.auth.oauth2.GoogleCredentials;
import com.google.auth.oauth2.IdToken;
import com.google.auth.oauth2.IdTokenProvider;
import com.google.cloud.iam.credentials.v1.IamCredentialsClient;
import com.google.cloud.iam.credentials.v1.IamCredentialsSettings;
import com.google.cloud.iam.credentials.v1.SignJwtRequest;
import com.google.cloud.iam.credentials.v1.SignJwtResponse;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import org.json.JSONObject;
import org.springframework.stereotype.Controller;
import org.springframework.ui.Model;
import org.springframework.web.bind.annotation.GetMapping;

/**
 * Defines a controller to handle HTTP requests.
 */
@Controller
public final class TokenController {

  /**
   * Create an endpoint for the landing page
   *
   * @return the index view template with a simple message
   */
  @GetMapping("/")
  public String loadJwtToken(Model model) throws Exception {
    String message = "";
    try {
      GoogleCredentials credential = GoogleCredentials.getApplicationDefault();
      ComputeEngineCredentials cred = ((ComputeEngineCredentials) credential);
      IamCredentialsSettings iamCredentialsSettings =
          IamCredentialsSettings.newBuilder()
              .setCredentialsProvider(FixedCredentialsProvider.create(credential))
              .build();
      IamCredentialsClient iamCredentialsClient = IamCredentialsClient.create(
          iamCredentialsSettings);
      String account = cred.getAccount();
      message += "\n =============================================";
      message += "\n Account is ";
      message += account;
      message += "\n =============================================";
      message += "\n Meta Data is";
      message += cred.getRequestMetadata();
      message += "\n =============================================";
      message += "\n access token is ";
      message += cred.getAccessToken();
      message += "\n =============================================";
      message += "\n id token is ";
      List options = new ArrayList<>();
      options.add(IdTokenProvider.Option.FORMAT_FULL);
      options.add(IdTokenProvider.Option.LICENSES_TRUE);
      options.add(IdTokenProvider.Option.INCLUDE_EMAIL);
      IdToken idToken = cred.idTokenWithAudience("http…//test.travix.com", options);
      message += idToken;
      message += "\n =============================================";
      SignJwtRequest jwtRequest;
      SignJwtRequest.Builder jwtBuilder = SignJwtRequest.newBuilder();
      // SA account assigned to the workload
      jwtBuilder.addDelegates("projects/-/serviceAccounts/" + account);
      // SA account assigned to the workload with serviceAccountTokenCreator
      jwtBuilder.setName("projects/-/serviceAccounts/" + account);
      JSONObject jwtDetails = new JSONObject();
      jwtDetails.put("iss", "app1-gsa@raniamoh-playground.iam.gserviceaccount.com");
      jwtDetails.put("sub", "app1-gsa@raniamoh-playground.iam.gserviceaccount.com");
      jwtDetails.put("aud", "http://some-service.travix.com");
      long now = new Date().getTime() / 1000;
      long exp = cred.getAccessToken().getExpirationTime().getTime() / 1000;
      jwtDetails.put("iat", now);
      jwtDetails.put("exp", exp);
      jwtDetails.put("scope", "https://www.googleapis.com/auth/cloud-platform");
      jwtBuilder = jwtBuilder.setPayload(jwtDetails.toString());
      jwtRequest = jwtBuilder.build();
      message += "\n =============================================";
      message += "\n jwt token body  " + jwtRequest;
      SignJwtResponse signResponse = iamCredentialsClient.signJwt(jwtRequest);
      message += "\n =============================================";
      message += "\n jwt token body  " + signResponse.toString();
      message += "\n =============================================";
      message += "\n jwt token is ";
      message += signResponse.getSignedJwt();
      model.addAttribute("message", message);
      iamCredentialsClient.close();
      return "index";
    } finally {

    }
  }
}