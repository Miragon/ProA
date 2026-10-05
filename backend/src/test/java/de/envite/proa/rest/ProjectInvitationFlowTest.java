package de.envite.proa.rest;

import de.envite.proa.repository.project.ProjectInvitationDao;
import io.quarkus.test.junit.QuarkusTest;
import io.quarkus.test.junit.TestProfile;
import io.smallrye.jwt.build.Jwt;
import jakarta.inject.Inject;
import jakarta.persistence.EntityManager;
import jakarta.transaction.Transactional;
import org.eclipse.microprofile.jwt.Claims;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static io.restassured.RestAssured.given;
import static org.hamcrest.Matchers.equalTo;
import static org.hamcrest.Matchers.hasSize;
import static org.hamcrest.Matchers.notNullValue;
import static org.hamcrest.Matchers.nullValue;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * End-to-end lifecycle of project invitations (ADR-0003) in web mode: inviting unknown e-mail
 * addresses stores pending invitations that are redeemed into memberships on the invitee's
 * first login with a verified e-mail; owners can list and revoke them.
 *
 * Reuses the hermetic web-mode profile of {@link WebModeAuthorizationTest} (locally signed
 * Keycloak-shaped tokens, no container).
 */
@QuarkusTest
@TestProfile(WebModeAuthorizationTest.WebModeProfile.class)
class ProjectInvitationFlowTest {

	private static final String ISSUER = "https://keycloak.test/realms/proa";
	private static final String OWNER_EMAIL = "owner@invitation.test";
	private static final String PROJECT_NAME = "Invitation Project";
	private static final String PROJECT_VERSION = "1.0";

	@Inject
	EntityManager em;

	@Inject
	ProjectInvitationDao invitationDao;

	@BeforeEach
	@Transactional
	void cleanupDatabase() {
		em.createNativeQuery("DELETE FROM ProjectInvitationTable").executeUpdate();
		em.createNativeQuery("DELETE FROM ProjectUserRelationTable").executeUpdate();
		em.createNativeQuery("DELETE FROM ProjectVersionTable").executeUpdate();
		em.createNativeQuery("DELETE FROM ProjectTable").executeUpdate();
		em.createNativeQuery("DELETE FROM UserTable").executeUpdate();
	}

	private static String token(String email) {
		return token(email, "invitation-sub-" + email, true);
	}

	private static String token(String email, String subject, boolean emailVerified) {
		return Jwt.claims() //
				.subject(subject) //
				.claim(Claims.email, email) //
				.claim(Claims.email_verified, emailVerified) //
				.claim("given_name", "Invitation") //
				.claim("family_name", "Tester") //
				.claim("realm_access", Map.of("roles", List.of("User"))) //
				.issuer(ISSUER) //
				.sign();
	}

	/** Provisions the local user row for the token (first login). */
	private static Integer provisionUser(String token) {
		return given() //
				.auth().oauth2(token) //
				.when().get("/api/user") //
				.then().statusCode(200) //
				.extract().path("id");
	}

	private static Long createProject(String ownerToken) {
		Integer id = given() //
				.auth().oauth2(ownerToken) //
				.formParam("name", PROJECT_NAME) //
				.formParam("version", PROJECT_VERSION) //
				.when().post("/api/project") //
				.then().statusCode(201) //
				.extract().path("id");
		return id.longValue();
	}

	private static Long singleVersionId(String ownerToken, Long projectId) {
		Integer versionId = given() //
				.auth().oauth2(ownerToken) //
				.when().get("/api/project/" + projectId) //
				.then().statusCode(200) //
				.extract().path("versions[0].id");
		return versionId.longValue();
	}

	private static List<Long> visibleProjectIds(String token) {
		List<Integer> ids = given() //
				.auth().oauth2(token) //
				.when().get("/api/project") //
				.then().statusCode(200) //
				.extract().path("id");
		return ids.stream().map(Integer::longValue).toList();
	}

	@Test
	void testInviteUnknownEmail_StoresPendingInvitation() {
		String ownerToken = token(OWNER_EMAIL);
		Long projectId = createProject(ownerToken);

		// The e-mail is normalized (trim + lower-case) before storing
		given() //
				.auth().oauth2(ownerToken) //
				.formParam("email", "  Ghost@Invitation.Test ") //
				.when().post("/api/project/" + projectId + "/contributor") //
				.then().statusCode(200) //
				.body("status", equalTo("INVITATION_PENDING")) //
				.body("invitation.id", notNullValue()) //
				.body("invitation.email", equalTo("ghost@invitation.test")) //
				.body("invitation.role", equalTo("COLLABORATEUR"));

		given() //
				.auth().oauth2(ownerToken) //
				.when().get("/api/project/" + projectId + "/invitation") //
				.then().statusCode(200) //
				.body("", hasSize(1)) //
				.body("[0].email", equalTo("ghost@invitation.test"));
	}

	@Test
	void testInviteExistingUser_CreatesMembershipImmediately() {
		String memberEmail = "member@invitation.test";
		String memberToken = token(memberEmail);
		provisionUser(memberToken);

		String ownerToken = token(OWNER_EMAIL);
		Long projectId = createProject(ownerToken);

		given() //
				.auth().oauth2(ownerToken) //
				.formParam("email", memberEmail) //
				.when().post("/api/project/" + projectId + "/contributor") //
				.then().statusCode(200) //
				.body("status", equalTo("MEMBER_ADDED")) //
				.body("invitation", nullValue());

		// The member sees the project immediately, no invitation is left behind
		assertTrue(visibleProjectIds(memberToken).contains(projectId));
		given() //
				.auth().oauth2(ownerToken) //
				.when().get("/api/project/" + projectId + "/invitation") //
				.then().statusCode(200) //
				.body("", hasSize(0));
	}

	@Test
	void testReinviteSameEmail_IsIdempotent() {
		String ownerToken = token(OWNER_EMAIL);
		Long projectId = createProject(ownerToken);
		String invitee = "twice@invitation.test";

		Integer firstId = given() //
				.auth().oauth2(ownerToken) //
				.formParam("email", invitee) //
				.when().post("/api/project/" + projectId + "/contributor") //
				.then().statusCode(200) //
				.extract().path("invitation.id");

		Integer secondId = given() //
				.auth().oauth2(ownerToken) //
				.formParam("email", invitee) //
				.when().post("/api/project/" + projectId + "/contributor") //
				.then().statusCode(200) //
				.body("status", equalTo("INVITATION_PENDING")) //
				.extract().path("invitation.id");

		assertEquals(firstId, secondId);
		given() //
				.auth().oauth2(ownerToken) //
				.when().get("/api/project/" + projectId + "/invitation") //
				.then().statusCode(200) //
				.body("", hasSize(1));
	}

	@Test
	void testFirstLoginWithVerifiedEmail_RedeemsInvitationsIntoMembership() {
		String ownerToken = token(OWNER_EMAIL);
		Long projectId = createProject(ownerToken);
		String inviteeEmail = "redeem@invitation.test";

		given() //
				.auth().oauth2(ownerToken) //
				.formParam("email", inviteeEmail) //
				.when().post("/api/project/" + projectId + "/contributor") //
				.then().statusCode(200) //
				.body("status", equalTo("INVITATION_PENDING"));

		// First login with a verified e-mail: the invitation becomes a membership
		String inviteeToken = token(inviteeEmail);
		assertTrue(visibleProjectIds(inviteeToken).contains(projectId));

		// ... and is deleted
		given() //
				.auth().oauth2(ownerToken) //
				.when().get("/api/project/" + projectId + "/invitation") //
				.then().statusCode(200) //
				.body("", hasSize(0));

		// Membership is stable on subsequent requests
		assertTrue(visibleProjectIds(inviteeToken).contains(projectId));
	}

	@Test
	void testUnverifiedEmail_DoesNotRedeemInvitations() {
		String ownerToken = token(OWNER_EMAIL);
		Long projectId = createProject(ownerToken);
		String inviteeEmail = "unverified@invitation.test";
		String inviteeSubject = "invitation-sub-" + inviteeEmail;

		given() //
				.auth().oauth2(ownerToken) //
				.formParam("email", inviteeEmail) //
				.when().post("/api/project/" + projectId + "/contributor") //
				.then().statusCode(200);

		// Unverified e-mail: no membership, the invitation stays pending
		String unverifiedToken = token(inviteeEmail, inviteeSubject, false);
		assertTrue(visibleProjectIds(unverifiedToken).isEmpty());
		given() //
				.auth().oauth2(ownerToken) //
				.when().get("/api/project/" + projectId + "/invitation") //
				.then().statusCode(200) //
				.body("", hasSize(1));

		// After verification the same principal gets the membership
		String verifiedToken = token(inviteeEmail, inviteeSubject, true);
		assertTrue(visibleProjectIds(verifiedToken).contains(projectId));
		given() //
				.auth().oauth2(ownerToken) //
				.when().get("/api/project/" + projectId + "/invitation") //
				.then().statusCode(200) //
				.body("", hasSize(0));
	}

	@Test
	void testRevokeInvitation_PreventsRedemption() {
		String ownerToken = token(OWNER_EMAIL);
		Long projectId = createProject(ownerToken);
		String inviteeEmail = "revoked@invitation.test";

		Integer invitationId = given() //
				.auth().oauth2(ownerToken) //
				.formParam("email", inviteeEmail) //
				.when().post("/api/project/" + projectId + "/contributor") //
				.then().statusCode(200) //
				.extract().path("invitation.id");

		given() //
				.auth().oauth2(ownerToken) //
				.when().delete("/api/project/" + projectId + "/invitation/" + invitationId) //
				.then().statusCode(204);

		given() //
				.auth().oauth2(ownerToken) //
				.when().get("/api/project/" + projectId + "/invitation") //
				.then().statusCode(200) //
				.body("", hasSize(0));

		// The revoked invitee logs in and gets nothing
		assertTrue(visibleProjectIds(token(inviteeEmail)).isEmpty());
	}

	@Test
	void testRevokeUnknownInvitation_NotFound() {
		String ownerToken = token(OWNER_EMAIL);
		Long projectId = createProject(ownerToken);

		given() //
				.auth().oauth2(ownerToken) //
				.when().delete("/api/project/" + projectId + "/invitation/12345") //
				.then().statusCode(404);
	}

	@Test
	void testInvitationEndpoints_NonOwner_Forbidden() {
		String ownerToken = token(OWNER_EMAIL);
		Long projectId = createProject(ownerToken);

		Integer invitationId = given() //
				.auth().oauth2(ownerToken) //
				.formParam("email", "pending@invitation.test") //
				.when().post("/api/project/" + projectId + "/contributor") //
				.then().statusCode(200) //
				.extract().path("invitation.id");

		String strangerToken = token("stranger@invitation.test");
		provisionUser(strangerToken);

		given() //
				.auth().oauth2(strangerToken) //
				.when().get("/api/project/" + projectId + "/invitation") //
				.then().statusCode(403);

		given() //
				.auth().oauth2(strangerToken) //
				.when().delete("/api/project/" + projectId + "/invitation/" + invitationId) //
				.then().statusCode(403);

		given() //
				.auth().oauth2(strangerToken) //
				.formParam("email", "someone-else@invitation.test") //
				.when().post("/api/project/" + projectId + "/contributor") //
				.then().statusCode(403);
	}

	@Test
	void testAddContributor_BlankEmail_BadRequest() {
		String ownerToken = token(OWNER_EMAIL);
		Long projectId = createProject(ownerToken);

		given() //
				.auth().oauth2(ownerToken) //
				.formParam("email", "   ") //
				.when().post("/api/project/" + projectId + "/contributor") //
				.then().statusCode(400);
	}

	@Test
	void testProjectDeletion_RemovesPendingInvitations() {
		String ownerToken = token(OWNER_EMAIL);
		Long projectId = createProject(ownerToken);
		Long versionId = singleVersionId(ownerToken, projectId);

		given() //
				.auth().oauth2(ownerToken) //
				.formParam("email", "orphan@invitation.test") //
				.when().post("/api/project/" + projectId + "/contributor") //
				.then().statusCode(200);

		// Removing the only version deletes the whole project
		given() //
				.auth().oauth2(ownerToken) //
				.when().delete("/api/project/" + projectId + "/" + versionId) //
				.then().statusCode(200);

		assertTrue(invitationDao.findByProject(projectId).isEmpty());
		// The invitee's first login must not fail over a dangling invitation
		assertTrue(visibleProjectIds(token("orphan@invitation.test")).isEmpty());
	}
}
