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

using CloudDemo.MvcCore.Models;
using Google.Apis.Auth;
using Google.Apis.Auth.OAuth2;
using Google.Apis.IAMCredentials.v1;
using Google.Apis.IAMCredentials.v1.Data;
using Google.Apis.Services;
using Microsoft.AspNetCore.Mvc;
using Newtonsoft.Json;
using System;
using System.Diagnostics;
using System.Net.Http;
using System.Threading.Tasks;

namespace CloudDemo.MvcCore.Controllers
{
    public class HomeController : Controller
    {
        public class CustomPayload : JsonWebSignature.Payload
        {
            [Newtonsoft.Json.JsonProperty("email")]
            public string Email { get; set; }
        }

        public static async Task<string> LoadJwtToken()
        {
            GoogleCredential credentials = await GoogleCredential.GetApplicationDefaultAsync();

            IAMCredentialsService iamClient = new IAMCredentialsService(new BaseClientService.Initializer
            {
                HttpClientInitializer = credentials
            });

            var idToken = await credentials.GetOidcTokenAsync(OidcTokenOptions.FromTargetAudience("http://will.be.ignored.travix.com"));
            var idTokenPayload = await JsonWebSignature.VerifySignedTokenAsync<CustomPayload>(await idToken.GetAccessTokenAsync());

            SignJwtRequest signRequest = new SignJwtRequest
            {
                Payload = JsonConvert.SerializeObject(new
                {
                    iss = "app1-gsa@raniamoh-playground.iam.gserviceaccount.com",
                    sub = "app1-gsa@raniamoh-playground.iam.gserviceaccount.com",
                    aud = "http://some-service.travix.com",
                    iat = DateTimeOffset.UtcNow.ToUnixTimeSeconds(),
                    exp = idTokenPayload.ExpirationTimeSeconds,
                    scope = "https://www.googleapis.com/auth/cloud-platform"
                })
            };

            SignJwtResponse signResponse = await iamClient.Projects.ServiceAccounts.SignJwt(
                signRequest,
                $"projects/-/serviceAccounts/{idTokenPayload.Email}").ExecuteAsync();

            string message = " =============================================";
            message += Environment.NewLine;
            message += " Account is ";
            message += idTokenPayload.Email;
            message += Environment.NewLine;
            message += " =============================================";
            message += Environment.NewLine;
            message += " id token is ";
            message += idToken;
            message += Environment.NewLine;
            message += " =============================================";
            message += Environment.NewLine;
            message += " custom jwt token " + signRequest.Payload;
            message += Environment.NewLine;
            message += " =============================================";
            message += Environment.NewLine;
            message += " signed custom jwt token is ";
            message += signResponse.SignedJwt;
            message += Environment.NewLine;
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
