package de.envite.proa.rest;

import de.envite.proa.entities.authentication.User;
import de.envite.proa.usecases.authentication.AuthenticationUsecase;
import de.envite.proa.usecases.authentication.exceptions.EmailAlreadyRegisteredException;
import io.quarkus.test.junit.QuarkusTest;
import io.restassured.http.ContentType;
import io.smallrye.jwt.build.Jwt;
import jakarta.inject.Inject;
import org.junit.jupiter.api.Test;

import java.util.Map;
import java.util.Set;

import static io.restassured.RestAssured.given;
import static org.hamcrest.Matchers.containsString;

/**
 * Verifies the bean validation of the registration endpoint. Login is intentionally not
 * validated so that the seeded admin account can still log in with its initial credentials.
 */
@QuarkusTest
class AuthenticationResourceValidationTest {

	private static final String ADMIN_EMAIL = "admin@admin.com";
	private static final String SEEDED_USERNAME = "seeded-admin";
	private static final String SEEDED_PASSWORD = "initial_pw";

	@Inject
	AuthenticationUsecase authenticationUsecase;

	private static String adminToken() {
		return Jwt //
				.issuer("proa-issuer") //
				.audience("proa-client") //
				.upn(ADMIN_EMAIL) //
				.groups(Set.of("Admin")) //
				.claim("userId", 1L) //
				.sign();
	}

	@Test
	void testRegister_MalformedEmailAndShortPassword_BadRequest() {
		given() //
				.auth().oauth2(adminToken()) //
				.contentType(ContentType.JSON) //
				.body(Map.of("email", "not-an-email", "password", "short")) //
				.when().post("/api/authentication/register") //
				.then() //
				.statusCode(400) //
				.body(containsString("email")) //
				.body(containsString("password"));
	}

	@Test
	void testRegister_BlankFields_BadRequest() {
		given() //
				.auth().oauth2(adminToken()) //
				.contentType(ContentType.JSON) //
				.body(Map.of("email", "", "password", "")) //
				.when().post("/api/authentication/register") //
				.then() //
				.statusCode(400);
	}

	@Test
	void testLogin_SeededUserWithShortPasswordAndNonEmailUsername_StillWorks()
			throws EmailAlreadyRegisteredException {
		// Seeded the same way AdminInitializer seeds the admin user (no bean validation)
		User user = new User();
		user.setEmail(SEEDED_USERNAME);
		user.setPassword(SEEDED_PASSWORD);
		user.setRole("Admin");
		try {
			authenticationUsecase.register(user);
		} catch (EmailAlreadyRegisteredException e) {
			// already seeded by a previous run
		}

		given() //
				.contentType(ContentType.JSON) //
				.body(Map.of("email", SEEDED_USERNAME, "password", SEEDED_PASSWORD)) //
				.when().post("/api/authentication/login") //
				.then() //
				.statusCode(200);
	}
}
