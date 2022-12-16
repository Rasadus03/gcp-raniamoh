package com.sample.webapp;

import org.springframework.stereotype.Controller;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.ui.Model;
@Controller
public class AppHomeController {
	@Value ("${name}")
	private String name ;
	@GetMapping(value = "/*")
	   public String index(Model model) {

		model.addAttribute("message", "Hi there this is a hi from "+name+"!!!");

		return "index";
	}

}
