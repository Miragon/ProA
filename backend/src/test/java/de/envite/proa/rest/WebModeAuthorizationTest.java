package de.envite.proa.rest;

import io.quarkus.test.junit.QuarkusTest;
import io.quarkus.test.junit.QuarkusTestProfile;
import io.quarkus.test.junit.TestProfile;
import io.smallrye.jwt.build.Jwt;
import org.eclipse.microprofile.jwt.Claims;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;

import static io.restassured.RestAssured.given;
import static org.hamcrest.Matchers.equalTo;
import static org.hamcrest.Matchers.notNullValue;
import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * Verifies that authorization is actually enforced in web mode (all other tests run with
 * app.mode=desktop where the OIDC tenant is disabled and the role checks are skipped).
 *
 * Tokens are Keycloak-shaped (realm_access.roles, email, sub) and signed with the checked-in
 * test private key; quarkus-oidc verifies them against quarkus.oidc.public-key, so the tests
 * stay hermetic and container-free (ADR-0001).
 */
@QuarkusTest
@TestProfile(WebModeAuthorizationTest.WebModeProfile.class)
class WebModeAuthorizationTest {

	private static final String ISSUER = "https://keycloak.test/realms/proa";
	private static final String DEFAULT_EMAIL = "web-mode-test@example.com";

	public static class WebModeProfile implements QuarkusTestProfile {

		@Override
		public Map<String, String> getConfigOverrides() {
			return Map.of( //
					"app.mode", "web", //
					// Re-enable OIDC (the test profile disables the tenant for the desktop-mode bulk)
					"quarkus.oidc.tenant-enabled", "true", //
					// Verify locally against the checked-in test public key instead of a Keycloak
					// server; unset the inherited auth-server-url so no connection is attempted.
					"quarkus.oidc.auth-server-url", "", //
					"quarkus.oidc.public-key", readTestPublicKey(), //
					// The issuer is enforced (the audience deliberately is not, see
					// application.properties): wrong/missing issuer must yield 401.
					"quarkus.oidc.token.issuer", ISSUER, //
					// Key used by the smallrye Jwt builder to sign the test tokens
					"smallrye.jwt.sign.key.location", "privateKey.test.pem");
		}

		private static String readTestPublicKey() {
			// quarkus.oidc.public-key accepts the base64 key material without PEM headers
			try (InputStream is = WebModeAuthorizationTest.class.getResourceAsStream("/publicKey.test.pem")) {
				return new String(is.readAllBytes(), StandardCharsets.UTF_8) //
						.replace("-----BEGIN PUBLIC KEY-----", "") //
						.replace("-----END PUBLIC KEY-----", "") //
						.replaceAll("\\s", "");
			} catch (IOException e) {
				throw new UncheckedIOException(e);
			}
		}
	}

	private static String token(String role) {
		return token(role, DEFAULT_EMAIL);
	}

	private static String token(String role, String email) {
		return keycloakShapedClaims(role, email) //
				.issuer(ISSUER) //
				.sign();
	}

	private static String tokenWithoutIssuer() {
		return keycloakShapedClaims("User", DEFAULT_EMAIL).sign();
	}

	private static String tokenWithWrongIssuer() {
		return keycloakShapedClaims("User", DEFAULT_EMAIL) //
				.issuer("https://evil.example.com/realms/proa") //
				.sign();
	}

	private static io.smallrye.jwt.build.JwtClaimsBuilder keycloakShapedClaims(String role, String email) {
		return Jwt.claims() //
				.subject("3f1c8b2e-" + email) //
				.claim(Claims.email, email) //
				.claim("given_name", "Web") //
				.claim("family_name", "Tester") //
				.claim("realm_access", Map.of("roles", List.of(role)));
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
				.auth().oauth2(token("Guest")) //
				.when().get("/api/user") //
				.then().statusCode(403);
	}

	/**
	 * The issuer claim must be enforced (quarkus.oidc.token.issuer): a token that is correctly
	 * signed but carries no issuer must be rejected as unauthenticated.
	 */
	@Test
	void testTokenWithoutIssuer_Unauthorized() {
		given() //
				.auth().oauth2(tokenWithoutIssuer()) //
				.when().get("/api/user") //
				.then().statusCode(401);
	}

	@Test
	void testTokenWithWrongIssuer_Unauthorized() {
		given() //
				.auth().oauth2(tokenWithWrongIssuer()) //
				.when().get("/api/user") //
				.then().statusCode(401);
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
				.auth().oauth2(token("Guest")) //
				.when().get("/api/project") //
				.then().statusCode(403);
	}

	@Test
	void testRolesAllowedIfWebVersion_WithUserRole_Allowed() {
		given() //
				.auth().oauth2(token("User")) //
				.when().get("/api/project") //
				.then().statusCode(200);
	}

	/**
	 * The first authenticated request provisions a local UserTable row from the token claims;
	 * subsequent requests reuse the same row (CurrentUserService).
	 */
	@Test
	void testFirstAuthenticatedCall_ProvisionsLocalUser() {
		String email = "provisioning-test@example.com";

		Integer id = given() //
				.auth().oauth2(token("User", email)) //
				.when().get("/api/user") //
				.then().statusCode(200) //
				.body("email", equalTo(email)) //
				.body("role", equalTo("User")) //
				.body("firstName", equalTo("Web")) //
				.body("lastName", equalTo("Tester")) //
				.body("id", notNullValue()) //
				.extract().path("id");

		Integer secondId = given() //
				.auth().oauth2(token("User", email)) //
				.when().get("/api/user") //
				.then().statusCode(200) //
				.body("email", equalTo(email)) //
				.extract().path("id");

		assertEquals(id, secondId);
	}

	@Test
	void testAdminToken_ProvisionsAdminAndSyncsRoleChange() {
		String email = "role-sync-test@example.com";

		Integer id = given() //
				.auth().oauth2(token("Admin", email)) //
				.when().get("/api/user") //
				.then().statusCode(200) //
				.body("role", equalTo("Admin")) //
				.extract().path("id");

		// The realm role changed in Keycloak -> the local role is synced on the next resolve
		Integer secondId = given() //
				.auth().oauth2(token("User", email)) //
				.when().get("/api/user") //
				.then().statusCode(200) //
				.body("role", equalTo("User")) //
				.extract().path("id");

		assertEquals(id, secondId);
	}
}
