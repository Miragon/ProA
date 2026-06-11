package de.envite.proa.rest;

import de.envite.proa.entities.project.AccessDeniedException;
import de.envite.proa.entities.project.NoResultException;
import de.envite.proa.security.CurrentUserService;
import de.envite.proa.usecases.project.ProjectAccessService;
import jakarta.ws.rs.ForbiddenException;
import jakarta.ws.rs.NotFoundException;
import jakarta.ws.rs.core.Response;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.MockitoAnnotations;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.Mockito.*;

public class ProjectAccessVerifierTest {

	private static final Long USER_ID = 1L;
	private static final Long PROJECT_VERSION_ID = 2L;
	private static final Long PROCESS_MODEL_ID = 3L;
	private static final Long CONNECTION_ID = 4L;
	private static final String APP_MODE_WEB = "web";
	private static final String APP_MODE_DESKTOP = "desktop";

	@InjectMocks
	private ProjectAccessVerifier verifier;

	@Mock
	private ProjectAccessService projectAccessService;

	@Mock
	private CurrentUserService currentUserService;

	@BeforeEach
	public void setUp() {
		MockitoAnnotations.openMocks(this);
	}

	@Test
	public void testVerifyAccessToProjectVersion_WebMode_MemberAllowed() {
		verifier.appMode = APP_MODE_WEB;
		when(currentUserService.getUserId()).thenReturn(USER_ID);

		assertDoesNotThrow(() -> verifier.verifyAccessToProjectVersion(PROJECT_VERSION_ID));

		verify(projectAccessService, times(1)).verifyAccessToProjectVersion(USER_ID, PROJECT_VERSION_ID);
	}

	@Test
	public void testVerifyAccessToProjectVersion_WebMode_Forbidden() {
		verifier.appMode = APP_MODE_WEB;
		when(currentUserService.getUserId()).thenReturn(USER_ID);
		doThrow(new AccessDeniedException()).when(projectAccessService)
				.verifyAccessToProjectVersion(USER_ID, PROJECT_VERSION_ID);

		ForbiddenException exception = assertThrows(ForbiddenException.class,
				() -> verifier.verifyAccessToProjectVersion(PROJECT_VERSION_ID));

		assertEquals(Response.Status.FORBIDDEN.getStatusCode(), exception.getResponse().getStatus());
	}

	@Test
	public void testVerifyAccessToProjectVersion_WebMode_NotFound() {
		verifier.appMode = APP_MODE_WEB;
		when(currentUserService.getUserId()).thenReturn(USER_ID);
		doThrow(new NoResultException()).when(projectAccessService)
				.verifyAccessToProjectVersion(USER_ID, PROJECT_VERSION_ID);

		NotFoundException exception = assertThrows(NotFoundException.class,
				() -> verifier.verifyAccessToProjectVersion(PROJECT_VERSION_ID));

		assertEquals(Response.Status.NOT_FOUND.getStatusCode(), exception.getResponse().getStatus());
	}

	@Test
	public void testVerifyAccessToProjectVersion_DesktopMode_NoCheck() {
		verifier.appMode = APP_MODE_DESKTOP;

		verifier.verifyAccessToProjectVersion(PROJECT_VERSION_ID);

		verify(currentUserService, never()).getUserId();
		verifyNoInteractions(projectAccessService);
	}

	@Test
	public void testVerifyAccessToProcessModel_WebMode_MemberAllowed() {
		verifier.appMode = APP_MODE_WEB;
		when(currentUserService.getUserId()).thenReturn(USER_ID);

		assertDoesNotThrow(() -> verifier.verifyAccessToProcessModel(PROCESS_MODEL_ID));

		verify(projectAccessService, times(1)).verifyAccessToProcessModel(USER_ID, PROCESS_MODEL_ID);
	}

	@Test
	public void testVerifyAccessToProcessModel_WebMode_Forbidden() {
		verifier.appMode = APP_MODE_WEB;
		when(currentUserService.getUserId()).thenReturn(USER_ID);
		doThrow(new AccessDeniedException()).when(projectAccessService)
				.verifyAccessToProcessModel(USER_ID, PROCESS_MODEL_ID);

		ForbiddenException exception = assertThrows(ForbiddenException.class,
				() -> verifier.verifyAccessToProcessModel(PROCESS_MODEL_ID));

		assertEquals(Response.Status.FORBIDDEN.getStatusCode(), exception.getResponse().getStatus());
	}

	@Test
	public void testVerifyAccessToProcessModel_WebMode_NotFound() {
		verifier.appMode = APP_MODE_WEB;
		when(currentUserService.getUserId()).thenReturn(USER_ID);
		doThrow(new NoResultException()).when(projectAccessService)
				.verifyAccessToProcessModel(USER_ID, PROCESS_MODEL_ID);

		NotFoundException exception = assertThrows(NotFoundException.class,
				() -> verifier.verifyAccessToProcessModel(PROCESS_MODEL_ID));

		assertEquals(Response.Status.NOT_FOUND.getStatusCode(), exception.getResponse().getStatus());
	}

	@Test
	public void testVerifyAccessToProcessModel_DesktopMode_NoCheck() {
		verifier.appMode = APP_MODE_DESKTOP;

		verifier.verifyAccessToProcessModel(PROCESS_MODEL_ID);

		verify(currentUserService, never()).getUserId();
		verifyNoInteractions(projectAccessService);
	}

	@Test
	public void testVerifyAccessToProcessConnection_WebMode_MemberAllowed() {
		verifier.appMode = APP_MODE_WEB;
		when(currentUserService.getUserId()).thenReturn(USER_ID);

		assertDoesNotThrow(() -> verifier.verifyAccessToProcessConnection(CONNECTION_ID));

		verify(projectAccessService, times(1)).verifyAccessToProcessConnection(USER_ID, CONNECTION_ID);
	}

	@Test
	public void testVerifyAccessToProcessConnection_WebMode_Forbidden() {
		verifier.appMode = APP_MODE_WEB;
		when(currentUserService.getUserId()).thenReturn(USER_ID);
		doThrow(new AccessDeniedException()).when(projectAccessService)
				.verifyAccessToProcessConnection(USER_ID, CONNECTION_ID);

		assertThrows(ForbiddenException.class, () -> verifier.verifyAccessToProcessConnection(CONNECTION_ID));
	}

	@Test
	public void testVerifyAccessToProcessConnection_WebMode_NotFound() {
		verifier.appMode = APP_MODE_WEB;
		when(currentUserService.getUserId()).thenReturn(USER_ID);
		doThrow(new NoResultException()).when(projectAccessService)
				.verifyAccessToProcessConnection(USER_ID, CONNECTION_ID);

		assertThrows(NotFoundException.class, () -> verifier.verifyAccessToProcessConnection(CONNECTION_ID));
	}

	@Test
	public void testVerifyAccessToProcessConnection_DesktopMode_NoCheck() {
		verifier.appMode = APP_MODE_DESKTOP;

		verifier.verifyAccessToProcessConnection(CONNECTION_ID);

		verify(currentUserService, never()).getUserId();
		verifyNoInteractions(projectAccessService);
	}

	@Test
	public void testVerifyAccessToDataStoreConnection_WebMode_MemberAllowed() {
		verifier.appMode = APP_MODE_WEB;
		when(currentUserService.getUserId()).thenReturn(USER_ID);

		assertDoesNotThrow(() -> verifier.verifyAccessToDataStoreConnection(CONNECTION_ID));

		verify(projectAccessService, times(1)).verifyAccessToDataStoreConnection(USER_ID, CONNECTION_ID);
	}

	@Test
	public void testVerifyAccessToDataStoreConnection_WebMode_Forbidden() {
		verifier.appMode = APP_MODE_WEB;
		when(currentUserService.getUserId()).thenReturn(USER_ID);
		doThrow(new AccessDeniedException()).when(projectAccessService)
				.verifyAccessToDataStoreConnection(USER_ID, CONNECTION_ID);

		assertThrows(ForbiddenException.class, () -> verifier.verifyAccessToDataStoreConnection(CONNECTION_ID));
	}

	@Test
	public void testVerifyAccessToDataStoreConnection_WebMode_NotFound() {
		verifier.appMode = APP_MODE_WEB;
		when(currentUserService.getUserId()).thenReturn(USER_ID);
		doThrow(new NoResultException()).when(projectAccessService)
				.verifyAccessToDataStoreConnection(USER_ID, CONNECTION_ID);

		assertThrows(NotFoundException.class, () -> verifier.verifyAccessToDataStoreConnection(CONNECTION_ID));
	}

	@Test
	public void testVerifyAccessToDataStoreConnection_DesktopMode_NoCheck() {
		verifier.appMode = APP_MODE_DESKTOP;

		verifier.verifyAccessToDataStoreConnection(CONNECTION_ID);

		verify(currentUserService, never()).getUserId();
		verifyNoInteractions(projectAccessService);
	}
}
