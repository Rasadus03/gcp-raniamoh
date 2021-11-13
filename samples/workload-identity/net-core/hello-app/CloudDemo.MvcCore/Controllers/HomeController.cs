//
// Copyright 2020 Google LLC
//
// Licensed to the Apache Software Foundation (ASF) under one
// or more contributor license agreements.  See the NOTICE file
// distributed with this work for additional information
// regarding copyright ownership.  The ASF licenses this file
// to you under the Apache License, Version 2.0 (the
// "License"); you may not use this file except in compliance
// with the License.  You may obtain a copy of the License at
// 
//   http://www.apache.org/licenses/LICENSE-2.0
// 
// Unless required by applicable law or agreed to in writing,
// software distributed under the License is distributed on an
// "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
// KIND, either express or implied.  See the License for the
// specific language governing permissions and limitations
// under the License.
//

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Mvc;
using CloudDemo.MvcCore.Models;
using Google.Apis.Auth.OAuth2;
using System.Net.Http;
using System.Net.Http.Headers;
using Newtonsoft.Json;
using System.IdentityModel.Tokens.Jwt;

namespace CloudDemo.MvcCore.Controllers
{
    public class HomeController : Controller
    {
        static HttpClient httpClient = new HttpClient();

        public static async Task<string> LoadJwtToken()
        {
            var credentials = GoogleCredential.GetApplicationDefault();
            var cred = (ICredential)credentials;
            var computeCred = (ComputeCredential)(credentials.UnderlyingCredential);
            var idToken = await credentials.GetOidcTokenAsync(OidcTokenOptions.FromTargetAudience("http…//test.travix.com"));
            var jwtidToken = await ((OidcToken)idToken).GetAccessTokenAsync();
            var handler = new JwtSecurityTokenHandler();
            var jsonToken = handler.ReadToken(jwtidToken);
            var tokenS = jsonToken as JwtSecurityToken;
            String[] tokenString = tokenS.Payload.SerializeToJson().Replace("\"", "").Split(",");
            var account = Array.Find(tokenString, element => element.StartsWith("email:")).Split(":")[1];
            var baseAddress = new Uri("https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/" + account + ":signJwt");
            var accessToken = await cred.GetAccessTokenForRequestAsync("https://other-service.travix.com");
            httpClient.DefaultRequestHeaders.AcceptCharset.Add(new StringWithQualityHeaderValue("utf-8"));
            httpClient.DefaultRequestHeaders.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
            httpClient.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", accessToken);
            long now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
            long exp = DateTimeOffset.Parse(computeCred.Token.IssuedUtc.AddSeconds(computeCred.Token.ExpiresInSeconds.Value).ToString()).ToUnixTimeSeconds();
            var payloadDetails = new
            {
                iss = "app1-gsa@raniamoh-playground.iam.gserviceaccount.com",
                sub = "app1-gsa@raniamoh-playground.iam.gserviceaccount.com",
                aud = "http://some-service.travix.com",
                iat = now,
                exp = exp,
                scope = "https://www.googleapis.com/auth/cloud-platform"
            };
            var payload = new
            {
                payload = JsonConvert.SerializeObject(payloadDetails)
            };
            var body = new StringContent(JsonConvert.SerializeObject(payload), System.Text.Encoding.UTF8, "application/json");
            string message = " =============================================";
            message += System.Environment.NewLine;
            message += " Account is ";
            message += account;
            message += System.Environment.NewLine;
            message += " =============================================";
            message += System.Environment.NewLine;
            message += " access token is ";
            message += accessToken;
            message += System.Environment.NewLine;
            message += " =============================================";
            message += System.Environment.NewLine;
            message += " id token is ";
            message += jwtidToken;
            message += System.Environment.NewLine;
            message += " =============================================";
            message += System.Environment.NewLine;
            message += " jwt token url  "                 + baseAddress;
            message += System.Environment.NewLine;
            message += " =============================================";
            message += System.Environment.NewLine;
            message += " jwt token headers  " + httpClient.DefaultRequestHeaders.Authorization;
            message += System.Environment.NewLine;
            message += " =============================================";
            message += System.Environment.NewLine;
            message += " jwt token body  " + await body.ReadAsStringAsync();
            var response = await httpClient.PostAsync(baseAddress, body);
            message += System.Environment.NewLine;
            message += " =============================================";
            message += System.Environment.NewLine;
            message += " jwt token is ";
            message += await response.Content.ReadAsStringAsync();
            message += System.Environment.NewLine;
            message += " =============================================";
            return message;
        }


        public static async Task<string> TryUrl(string url)
        {
            var httpRequest = new HttpRequestMessage(HttpMethod.Get, url);
            httpRequest.Headers.Add("Metadata-Flavor", "Google");
            var httpClient = new HttpClient();
            var response = await httpClient.SendAsync(httpRequest, default).ConfigureAwait(false);
            return $"StatusCode: {response.StatusCode} for URL: {url}";
        }


        public async Task<ActionResult> Index()
        {
            return View(new HomeViewModel(await LoadJwtToken()));
        }

        [ResponseCache(Duration = 0, Location = ResponseCacheLocation.None, NoStore = true)]
        public IActionResult Error()
        {
            return View(new ErrorViewModel { RequestId = Activity.Current?.Id ?? HttpContext.TraceIdentifier });
        }
    }
}
