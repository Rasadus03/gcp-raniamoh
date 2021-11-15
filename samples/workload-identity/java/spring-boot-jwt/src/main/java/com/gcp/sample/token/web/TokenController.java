
package com.gcp.sample.token.web;

import com.fasterxml.jackson.core.JsonGenerator;
import com.google.api.client.json.webtoken.JsonWebSignature;
import com.google.api.client.json.webtoken.JsonWebToken;
import com.google.auth.oauth2.AccessToken;
import com.google.auth.oauth2.ComputeEngineCredentials;
import com.google.auth.oauth2.CredentialAccessBoundary;
import com.google.auth.oauth2.CredentialAccessBoundary.AccessBoundaryRule.AvailabilityCondition;
import com.google.auth.oauth2.DownscopedCredentials;
import com.google.auth.oauth2.GoogleCredentials;
import com.google.auth.oauth2.IdTokenProvider;
import com.google.auth.oauth2.JwtClaims;
import com.google.auth.oauth2.TokenVerifier;
import com.google.iam.v1.IamPolicyProto;
import java.io.IOException;
import java.io.StringWriter;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import org.apache.http.HttpEntity;
import org.apache.http.NameValuePair;
import org.apache.http.client.HttpClient;
import org.apache.http.client.methods.CloseableHttpResponse;
import org.apache.http.client.methods.HttpPost;
import org.apache.http.client.methods.HttpUriRequest;
import org.apache.http.entity.BasicHttpEntity;
import org.apache.http.entity.ContentType;
import org.apache.http.entity.StringEntity;
import org.apache.http.impl.DefaultBHttpClientConnection;
import org.apache.http.impl.client.CloseableHttpClient;
import org.apache.http.impl.client.HttpClientBuilder;
import org.apache.http.impl.client.HttpClients;
import org.apache.http.impl.conn.DefaultManagedHttpClientConnection;
import org.apache.http.util.EntityUtils;
import org.json.JSONObject;
import org.springframework.boot.jackson.JsonObjectSerializer;
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
  public String helloWorld(Model model) throws Exception {
    String message = "";
    try {
      GoogleCredentials credential = GoogleCredentials.getApplicationDefault();
      ComputeEngineCredentials cred = ((ComputeEngineCredentials) credential);
      message += "\n =============================================";
      message += "\n Account is ";
      message += cred.getAccount();
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
      message += cred.idTokenWithAudience("http…//test.travix.com", options);
      message += "\n =============================================";
      try (CloseableHttpClient httpclient = HttpClientBuilder.create().build()) {
        HttpPost httpPost = new HttpPost(
            "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/"
                + cred.getAccount() + ":signJwt");
        httpPost.setHeader("Authorization", "Bearer " + cred.getAccessToken().getTokenValue());
        httpPost.setHeader("Content-Type", " application/json");
        httpPost.setHeader("charset", "utf-8");
        message += "\n jwt token url  " + httpPost.getURI();
        message += "\n =============================================";
        message += "\n jwt token headers  " + httpPost.getFirstHeader("Authorization");
        JSONObject payload = new JSONObject();
        JSONObject jwtDetails = new JSONObject();
        jwtDetails.put("iss", "app1-gsa@raniamoh-playground.iam.gserviceaccount.com");
        jwtDetails.put("sub", "app1-gsa@raniamoh-playground.iam.gserviceaccount.com");
        jwtDetails.put("aud", "http://some-service.travix.com");
        long now = new Date().getTime() / 1000;
        long exp = cred.getAccessToken().getExpirationTime().getTime() / 1000;
        jwtDetails.put("iat", now);
        jwtDetails.put("exp", exp);
        jwtDetails.put("scope", "https://www.googleapis.com/auth/cloud-platform");
        payload.put("payload", jwtDetails.toString());
        httpPost.setEntity(new StringEntity(payload.toString(), ContentType.APPLICATION_JSON));
        message += "\n =============================================";
        message += "\n jwt token body  " + EntityUtils.toString(httpPost.getEntity());
        try (CloseableHttpResponse response1 = httpclient.execute(httpPost)) {
          System.out.println(
              response1.getStatusLine().getReasonPhrase() + " " + response1.getStatusLine()
                  .getStatusCode());
          message += "\n =============================================";
          message += "\n jwt token is ";
          message += EntityUtils.toString(response1.getEntity());
        }
      } catch (Exception ioException) {
        ioException.printStackTrace();
      }
      finally {
      }
      model.addAttribute("message", message);
      return "index";
    } finally {

    }
  }
}