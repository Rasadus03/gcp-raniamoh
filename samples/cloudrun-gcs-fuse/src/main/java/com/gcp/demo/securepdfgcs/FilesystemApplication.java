/*
 * Copyright 2021 Google LLC
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

package com.gcp.demo.securepdfgcs;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.OutputStream;
import javax.annotation.PreDestroy;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.HandlerMapping;

@SpringBootApplication
public class FilesystemApplication {

  // Set config for file system path and filename prefix
  String mntDir = System.getenv().getOrDefault("MNT_DIR", "/mnt/nfs/filestore");

  @RestController
  /** 
   * Redirects to the file system path to interact with file system
   * Writes a new file on each request 
   * */
  class FilesystemController {

    @GetMapping("/**")
    void index(HttpServletRequest request, HttpServletResponse response)
        throws IOException {
      // Retrieve URL path
      String path =
          (String) request.getAttribute(HandlerMapping.PATH_WITHIN_HANDLER_MAPPING_ATTRIBUTE);
          
      // Redirect to mount path
      if (!path.startsWith(mntDir)) {
        response.sendRedirect(mntDir);
      }

      String html = "<html><body>\n";
      if (!path.equals(mntDir)) {
        // Add parent mount path link
        html += String.format("<a href=\"%s\">%s</a><br/><br/>\n", mntDir, mntDir);
      }

      // Return all files if path is a directory, else return the file
      File filePath = new File(path);
      if (filePath.isDirectory()) {
        File[] files = filePath.listFiles();
        for (File file : files) {
          html +=
              String.format("<a href=\"%s\">%s</a><br/>\n", file.getAbsolutePath(), file.getName());
        }
      } else {
          readFile(request, response, path);
      }

      html += "</body></html>\n";
      if (filePath.isDirectory()) {
         response.getOutputStream().println(html);
      }
     }
  }

  public static void main(String[] args) {
    SpringApplication.run(FilesystemApplication.class, args);
  }



  /**
   * Read files and return contents
   *
   * @param fullPath The path to the file
   * @return The file data
   * @throws IOException if the file does not exist
   */
  public static void readFile(HttpServletRequest request, HttpServletResponse response,String fullPath) throws IOException {
    File f = new File(fullPath);
    response.setHeader("Content-Length",String.valueOf(f.length()));
    FileInputStream fileInputStream = new FileInputStream(f);
   // byte[] encoded = new Base64().encode(bytes);
    //String data = new String(bytes);
    // setting the content type
    response.setContentType("application/pdf");
    OutputStream os = response.getOutputStream();
    try {
    byte[] buffer = new byte[1024];
    int len = 0;
    while ((len = fileInputStream.read(buffer)) >= 0) {
      os.write(buffer, 0, len);
    }}
 finally {
        fileInputStream.close();
        os.flush();
        os.close();
      }
    //return data;
  }

  /** Register shutdown hook */
  @PreDestroy
  public void tearDown() {
    System.out.println(FilesystemApplication.class.getSimpleName() + ": received SIGTERM.");
  }
}
