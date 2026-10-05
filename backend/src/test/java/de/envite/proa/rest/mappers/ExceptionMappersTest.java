package de.envite.proa.rest.mappers;

import io.quarkus.test.junit.QuarkusTest;
import org.junit.jupiter.api.Test;

import static io.restassured.RestAssured.given;
import static org.hamcrest.Matchers.containsString;
import static org.hamcrest.Matchers.equalTo;
import static org.hamcrest.Matchers.not;

/**
 * HTTP-level checks that the {@code @Provider} exception mappers reproduce the status codes
 * and body shapes the resources previously built in their try/catch blocks.
 */
@QuarkusTest
class ExceptionMappersTest {

	@Test
	void testAccessDeniedException_Forbidden() {
		given() //
				.when().get("/test/exception-mappers/access-denied") //
				.then().statusCode(403) //
				.body("error", equalTo("no access to project"));
	}

	@Test
	void testNoResultException_NotFound() {
		given() //
				.when().get("/test/exception-mappers/no-result") //
				.then().statusCode(404) //
				.body("error", equalTo("project not found"));
	}

	@Test
	void testEntityNotFoundException_NotFound() {
		given() //
				.when().get("/test/exception-mappers/entity-not-found") //
				.then().statusCode(404) //
				.body("error", equalTo("entity not found"));
	}

	@Test
	void testCantReplaceWithCollaborationException_BadRequest_WithExceptionTypeBody() {
		given() //
				.when().get("/test/exception-mappers/cant-replace-with-collaboration") //
				.then().statusCode(400) //
				// the frontend relies on the exceptionType property of the serialized exception
				.body("exceptionType", equalTo("CantReplaceWithCollaborationException")) //
				.body("message", containsString(ExceptionMapperTestResource.PROCESS_MODEL_ID.toString()));
	}

	@Test
	void testModelParseException_BadRequest_WithoutLeakingParserInternals() {
		given() //
				.when().get("/test/exception-mappers/model-parse") //
				.then().statusCode(400) //
				.body("error", equalTo("Invalid BPMN file")) //
				.body(not(containsString("parser internals that must not leak")));
	}

	@Test
	void testGenericException_InternalServerError_WithoutLeakingInternals() {
		given() //
				.when().get("/test/exception-mappers/generic") //
				.then().statusCode(500) //
				.body("error", equalTo("Internal server error")) //
				.body(not(containsString("internal detail that must not leak")));
	}

	@Test
	void testWebApplicationException_KeepsItsResponse() {
		given() //
				.when().get("/test/exception-mappers/web-application") //
				.then().statusCode(404);
	}
}
