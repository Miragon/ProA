package de.envite.proa.camundacloud;

import io.quarkus.test.junit.QuarkusTest;
import jakarta.inject.Inject;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertNotNull;

@QuarkusTest
class CamundaOperateServiceFactoryTest {

	private static final String TEST_BASE_URI = "https://test.operate.camunda.io/";

	@Inject
	CamundaOperateServiceFactory factory;

	@Test
	void testCreateOperateService() {
		CamundaOperateService result = factory.createOperateService(TEST_BASE_URI);

		assertNotNull(result, "CamundaOperateService should not be null.");
	}
}
