package de.envite.proa.rest;

import io.quarkus.test.junit.QuarkusTest;
import io.quarkus.test.junit.QuarkusTestProfile;
import io.quarkus.test.junit.TestProfile;
import io.smallrye.jwt.build.Jwt;
import org.junit.jupiter.api.Test;

import java.util.Map;
import java.util.Set;

import static io.restassured.RestAssured.given;

/**
 * Verifies that authorization is actually enforced in web mode (all other tests run with
 * app.mode=desktop where the role checks are skipped).
 */
@QuarkusTest
@TestProfile(WebModeAuthorizationTest.WebModeProfile.class)
class WebModeAuthorizationTest {

	public static class WebModeProfile implements QuarkusTestProfile {

		@Override
		public Map<String, String> getConfigOverrides() {
			return Map.of("app.mode", "web");
		}
	}

	private static String tokenWithRole(String role) {
		return Jwt //
				.issuer("proa-issuer") //
				.audience("proa-client") //
				.upn("web-mode-test@example.com") //
				.groups(Set.of(role)) //
				.claim("userId", 999L) //
				.sign();
	}

	@Test
	void testRequestWithoutToken_Unauthorized() {
		given() //
				.when().get("/api/user") //
				.then().statusCode(401);
	}

	@Test
	void testRequestWithWrongRole_Forbidden() {
		given() //
				.auth().oauth2(tokenWithRole("Guest")) //
				.when().get("/api/user") //
				.then().statusCode(403);
	}

	@Test
	void testRolesAllowedIfWebVersion_WithoutToken_Forbidden() {
		given() //
				.when().get("/api/project") //
				.then().statusCode(403);
	}

	@Test
	void testRolesAllowedIfWebVersion_WithWrongRole_Forbidden() {
		given() //
				.auth().oauth2(tokenWithRole("Guest")) //
				.when().get("/api/project") //
				.then().statusCode(403);
	}

	@Test
	void testRolesAllowedIfWebVersion_WithUserRole_Allowed() {
		given() //
				.auth().oauth2(tokenWithRole("User")) //
				.when().get("/api/project") //
				.then().statusCode(200);
	}
}
