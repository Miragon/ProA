package de.envite.proa.security;

import java.util.Set;

import org.eclipse.microprofile.jwt.Claims;
import org.eclipse.microprofile.jwt.JsonWebToken;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.MockitoAnnotations;

import de.envite.proa.entities.authentication.Role;
import de.envite.proa.repository.project.ProjectInvitationDao;
import de.envite.proa.repository.tables.UserTable;
import de.envite.proa.repository.user.UserDao;
import io.quarkus.security.identity.SecurityIdentity;
import jakarta.persistence.PersistenceException;
import jakarta.ws.rs.NotAuthorizedException;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

/**
 * Unit tests for the subject-bound identity resolution (lookup by sub, one-time legacy claim,
 * profile sync, invitation redemption) including the recovery paths of the provisioning races
 * on the unique oidcSubject key.
 */
class CurrentUserServiceTest {

	private static final String SUBJECT = "subject-123";
	private static final String EMAIL = "user@example.com";
	private static final String FIRST_NAME = "First";
	private static final String LAST_NAME = "Last";
	private static final Long USER_ID = 42L;

	@InjectMocks
	private CurrentUserService service;

	@Mock
	private JsonWebToken jwt;

	@Mock
	private SecurityIdentity securityIdentity;

	@Mock
	private UserDao userDao;

	@Mock
	private ProjectInvitationDao projectInvitationDao;

	@BeforeEach
	void setUp() {
		MockitoAnnotations.openMocks(this);
		when(jwt.getSubject()).thenReturn(SUBJECT);
		when(jwt.getClaim(Claims.email)).thenReturn(EMAIL);
		when(jwt.getClaim(Claims.email_verified)).thenReturn(Boolean.TRUE);
		when(jwt.getClaim("given_name")).thenReturn(FIRST_NAME);
		when(jwt.getClaim("family_name")).thenReturn(LAST_NAME);
		when(securityIdentity.getRoles()).thenReturn(Set.of("User"));
		when(userDao.patchUser(any(UserTable.class))).thenAnswer(invocation -> invocation.getArgument(0));
	}

	private UserTable syncedRow() {
		UserTable row = new UserTable();
		row.setId(USER_ID);
		row.setOidcSubject(SUBJECT);
		row.setEmail(EMAIL);
		row.setFirstName(FIRST_NAME);
		row.setLastName(LAST_NAME);
		row.setRole(Role.User);
		return row;
	}

	@Test
	void testResolve_ExistingRowFoundBySubject() {
		UserTable row = syncedRow();
		when(userDao.findBySubject(SUBJECT)).thenReturn(row);

		assertEquals(USER_ID, service.getUserId());

		verify(userDao, never()).save(any());
		verify(userDao, never()).claimSubject(anyLong(), anyString());
		verify(userDao, never()).patchUser(any());
	}

	@Test
	void testResolve_FirstLogin_ProvisionsRowWithSubjectAndProfile() {
		when(userDao.findBySubject(SUBJECT)).thenReturn(null);
		when(userDao.findLegacyByEmail(EMAIL)).thenReturn(null);
		when(userDao.save(any(UserTable.class))).thenAnswer(invocation -> {
			UserTable saved = invocation.getArgument(0);
			saved.setId(USER_ID);
			return saved;
		});

		assertEquals(USER_ID, service.getUserId());

		ArgumentCaptor<UserTable> captor = ArgumentCaptor.forClass(UserTable.class);
		verify(userDao).save(captor.capture());
		UserTable saved = captor.getValue();
		assertEquals(SUBJECT, saved.getOidcSubject());
		assertEquals(EMAIL, saved.getEmail());
		assertEquals(FIRST_NAME, saved.getFirstName());
		assertEquals(LAST_NAME, saved.getLastName());
		assertEquals(Role.User, saved.getRole());
		assertNotNull(saved.getCreatedAt());
		assertNotNull(saved.getModifiedAt());
	}

	@Test
	void testResolve_TokenEmailIsNormalized() {
		when(jwt.getClaim(Claims.email)).thenReturn("  User@Example.COM ");
		when(userDao.findBySubject(SUBJECT)).thenReturn(null);
		when(userDao.findLegacyByEmail(EMAIL)).thenReturn(null);
		when(userDao.save(any(UserTable.class))).thenAnswer(invocation -> {
			UserTable saved = invocation.getArgument(0);
			saved.setId(USER_ID);
			return saved;
		});

		service.getUser();

		verify(userDao).findLegacyByEmail(EMAIL);
		ArgumentCaptor<UserTable> captor = ArgumentCaptor.forClass(UserTable.class);
		verify(userDao).save(captor.capture());
		assertEquals(EMAIL, captor.getValue().getEmail());
	}

	/** A parallel first request won the unique-constraint race on oidcSubject. */
	@Test
	void testResolve_LostProvisioningRace_UsesWinnersRow() {
		UserTable winners = syncedRow();
		when(userDao.findBySubject(SUBJECT)).thenReturn(null, winners);
		when(userDao.findLegacyByEmail(EMAIL)).thenReturn(null);
		when(userDao.save(any(UserTable.class))).thenThrow(new PersistenceException("duplicate oidcSubject"));

		assertEquals(USER_ID, service.getUserId());
	}

	@Test
	void testResolve_InsertFailsWithoutWinner_Rethrows() {
		when(userDao.findBySubject(SUBJECT)).thenReturn(null);
		when(userDao.findLegacyByEmail(EMAIL)).thenReturn(null);
		when(userDao.save(any(UserTable.class))).thenThrow(new PersistenceException("connection lost"));

		assertThrows(PersistenceException.class, () -> service.getUserId());
	}

	/** One-time migration: a row predating the subject binding is claimed via its e-mail. */
	@Test
	void testResolve_LegacyRow_ClaimedBySubject() {
		UserTable legacy = syncedRow();
		legacy.setOidcSubject(null);
		when(userDao.findBySubject(SUBJECT)).thenReturn(null);
		when(userDao.findLegacyByEmail(EMAIL)).thenReturn(legacy);
		when(userDao.claimSubject(USER_ID, SUBJECT)).thenReturn(true);
		UserTable claimed = syncedRow();
		when(userDao.findById(USER_ID)).thenReturn(claimed);

		assertEquals(USER_ID, service.getUserId());

		verify(userDao).claimSubject(USER_ID, SUBJECT);
		verify(userDao, never()).save(any());
	}

	/**
	 * An unverified e-mail must not be able to claim a legacy row (self-registering someone
	 * else's address would otherwise inherit their projects) - and no fresh row is created
	 * either, so the rightful owner can still claim after verifying.
	 */
	@Test
	void testResolve_LegacyRow_UnverifiedEmail_Rejected() {
		when(jwt.getClaim(Claims.email_verified)).thenReturn(Boolean.FALSE);
		UserTable legacy = syncedRow();
		legacy.setOidcSubject(null);
		when(userDao.findBySubject(SUBJECT)).thenReturn(null);
		when(userDao.findLegacyByEmail(EMAIL)).thenReturn(legacy);

		assertThrows(NotAuthorizedException.class, () -> service.getUserId());

		verify(userDao, never()).claimSubject(anyLong(), anyString());
		verify(userDao, never()).save(any());
	}

	/** Without a legacy row an unverified e-mail provisions normally (nothing to inherit). */
	@Test
	void testResolve_UnverifiedEmail_NoLegacyRow_ProvisionsFreshRow() {
		when(jwt.getClaim(Claims.email_verified)).thenReturn(Boolean.FALSE);
		when(userDao.findBySubject(SUBJECT)).thenReturn(null);
		when(userDao.findLegacyByEmail(EMAIL)).thenReturn(null);
		when(userDao.save(any(UserTable.class))).thenAnswer(invocation -> {
			UserTable saved = invocation.getArgument(0);
			saved.setId(USER_ID);
			return saved;
		});

		assertEquals(USER_ID, service.getUserId());
		verify(projectInvitationDao, never()).redeemInvitations(anyLong(), anyString());
	}

	/** A parallel first request of the same user claimed the legacy row a moment earlier. */
	@Test
	void testResolve_LostClaimRaceToParallelRequest_UsesClaimedRow() {
		UserTable legacy = syncedRow();
		legacy.setOidcSubject(null);
		UserTable claimed = syncedRow();
		when(userDao.findBySubject(SUBJECT)).thenReturn(null, claimed);
		when(userDao.findLegacyByEmail(EMAIL)).thenReturn(legacy);
		when(userDao.claimSubject(USER_ID, SUBJECT)).thenReturn(false);

		assertEquals(USER_ID, service.getUserId());

		verify(userDao, never()).save(any());
	}

	/**
	 * The legacy row was claimed by a *different* principal (e-mail recycling): this identity
	 * must not inherit it and gets a fresh row instead.
	 */
	@Test
	void testResolve_LegacyRowClaimedByDifferentSubject_GetsFreshRow() {
		UserTable legacy = syncedRow();
		legacy.setOidcSubject(null);
		when(userDao.findBySubject(SUBJECT)).thenReturn(null);
		when(userDao.findLegacyByEmail(EMAIL)).thenReturn(legacy);
		when(userDao.claimSubject(USER_ID, SUBJECT)).thenReturn(false);
		when(userDao.save(any(UserTable.class))).thenAnswer(invocation -> {
			UserTable saved = invocation.getArgument(0);
			saved.setId(77L);
			return saved;
		});

		assertEquals(77L, service.getUserId());

		ArgumentCaptor<UserTable> captor = ArgumentCaptor.forClass(UserTable.class);
		verify(userDao).save(captor.capture());
		assertEquals(SUBJECT, captor.getValue().getOidcSubject());
	}

	/** E-mail (and names) are profile data refreshed from the token on every resolve. */
	@Test
	void testResolve_ChangedEmail_UpdatesRowInsteadOfCreatingNewOne() {
		UserTable row = syncedRow();
		row.setEmail("old@example.com");
		when(userDao.findBySubject(SUBJECT)).thenReturn(row);

		UserTable resolved = service.getUser();

		assertEquals(USER_ID, resolved.getId());
		ArgumentCaptor<UserTable> captor = ArgumentCaptor.forClass(UserTable.class);
		verify(userDao).patchUser(captor.capture());
		assertEquals(EMAIL, captor.getValue().getEmail());
		assertNotNull(captor.getValue().getModifiedAt());
		verify(userDao, never()).save(any());
	}

	@Test
	void testResolve_ChangedNames_Synced() {
		UserTable row = syncedRow();
		row.setFirstName("Stale");
		row.setLastName("Name");
		when(userDao.findBySubject(SUBJECT)).thenReturn(row);

		service.getUser();

		ArgumentCaptor<UserTable> captor = ArgumentCaptor.forClass(UserTable.class);
		verify(userDao).patchUser(captor.capture());
		assertEquals(FIRST_NAME, captor.getValue().getFirstName());
		assertEquals(LAST_NAME, captor.getValue().getLastName());
	}

	@Test
	void testResolve_ChangedRole_Synced() {
		when(securityIdentity.getRoles()).thenReturn(Set.of("User", "Admin"));
		UserTable row = syncedRow();
		when(userDao.findBySubject(SUBJECT)).thenReturn(row);

		service.getUser();

		ArgumentCaptor<UserTable> captor = ArgumentCaptor.forClass(UserTable.class);
		verify(userDao).patchUser(captor.capture());
		assertEquals(Role.Admin, captor.getValue().getRole());
	}

	/** Absent claims keep the cached profile values instead of wiping them. */
	@Test
	void testResolve_AbsentProfileClaims_KeepCachedValues() {
		when(jwt.getClaim(Claims.email)).thenReturn(null);
		when(jwt.getClaim("given_name")).thenReturn(null);
		when(jwt.getClaim("family_name")).thenReturn(null);
		UserTable row = syncedRow();
		when(userDao.findBySubject(SUBJECT)).thenReturn(row);

		UserTable resolved = service.getUser();

		assertEquals(EMAIL, resolved.getEmail());
		assertEquals(FIRST_NAME, resolved.getFirstName());
		verify(userDao, never()).patchUser(any());
	}

	@Test
	void testResolve_VerifiedEmail_RedeemsInvitations() {
		when(userDao.findBySubject(SUBJECT)).thenReturn(syncedRow());

		service.getUser();

		verify(projectInvitationDao, times(1)).redeemInvitations(USER_ID, EMAIL);
	}

	@Test
	void testResolve_UnverifiedEmail_DoesNotRedeemInvitations() {
		when(jwt.getClaim(Claims.email_verified)).thenReturn(Boolean.FALSE);
		when(userDao.findBySubject(SUBJECT)).thenReturn(syncedRow());

		service.getUser();

		verify(projectInvitationDao, never()).redeemInvitations(anyLong(), anyString());
	}

	@Test
	void testResolve_MissingEmailVerifiedClaim_TreatedAsUnverified() {
		when(jwt.getClaim(Claims.email_verified)).thenReturn(null);
		when(userDao.findBySubject(SUBJECT)).thenReturn(syncedRow());

		service.getUser();

		verify(projectInvitationDao, never()).redeemInvitations(anyLong(), anyString());
	}

	/**
	 * A redemption that loses the unique-membership race (concurrent addContributor or
	 * parallel redemption) is retried once; the request itself must not fail.
	 */
	@Test
	void testResolve_RedemptionRace_RetriedOnce() {
		when(userDao.findBySubject(SUBJECT)).thenReturn(syncedRow());
		doThrow(new PersistenceException("duplicate membership")).doNothing()//
				.when(projectInvitationDao).redeemInvitations(USER_ID, EMAIL);

		assertEquals(USER_ID, service.getUserId());

		verify(projectInvitationDao, times(2)).redeemInvitations(USER_ID, EMAIL);
	}

	/** If the retry fails too, the invitations stay pending for the next request. */
	@Test
	void testResolve_RedemptionFailsTwice_LeavesInvitationsPending() {
		when(userDao.findBySubject(SUBJECT)).thenReturn(syncedRow());
		doThrow(new PersistenceException("still racing"))//
				.when(projectInvitationDao).redeemInvitations(USER_ID, EMAIL);

		assertEquals(USER_ID, service.getUserId());

		verify(projectInvitationDao, times(2)).redeemInvitations(USER_ID, EMAIL);
	}

	@Test
	void testResolve_MissingSubject_Unauthorized() {
		when(jwt.getSubject()).thenReturn(null);

		assertThrows(NotAuthorizedException.class, () -> service.getUserId());
	}

	/** The row is resolved once per request and cached. */
	@Test
	void testGetUser_CachesResolvedRow() {
		when(userDao.findBySubject(SUBJECT)).thenReturn(syncedRow());

		service.getUser();
		service.getUser();

		verify(userDao, times(1)).findBySubject(SUBJECT);
	}
}
