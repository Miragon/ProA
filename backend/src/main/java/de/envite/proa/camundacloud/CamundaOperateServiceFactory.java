package de.envite.proa.camundacloud;

import jakarta.enterprise.context.ApplicationScoped;
import org.eclipse.microprofile.rest.client.RestClientBuilder;

import java.net.URI;

@ApplicationScoped
public class CamundaOperateServiceFactory {

	public CamundaOperateService createOperateService(String baseUri) {
		return RestClientBuilder
				.newBuilder()
				.baseUri(URI.create(baseUri))
				.build(CamundaOperateService.class);
	}
}
