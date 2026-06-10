package de.envite.proa.repository;

import de.envite.proa.entities.project.AccessDeniedException;
import de.envite.proa.entities.project.NoResultException;
import de.envite.proa.repository.project.ProjectAccessDao;
import de.envite.proa.repository.project.ProjectAccessRepositoryImpl;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.MockitoAnnotations;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.Mockito.when;

class ProjectAccessRepositoryImplTest {

	private static final Long MEMBER_USER_ID = 1L;
	private static final Long OTHER_USER_ID = 2L;
	private static final Long PROJECT_ID = 10L;
	private static final Long PROJECT_VERSION_ID = 20L;
	private static final Long PROCESS_MODEL_ID = 30L;
	private static final Long PROCESS_CONNECTION_ID = 40L;
	private static final Long DATA_STORE_CONNECTION_ID = 50L;
	private static final Long UNKNOWN_ID = 99L;

	@InjectMocks
	ProjectAccessRepositoryImpl repository;

	@Mock
	ProjectAccessDao dao;

	@BeforeEach
	void setUp() {
		MockitoAnnotations.openMocks(this);

		when(dao.existsProject(PROJECT_ID)).thenReturn(true);
		when(dao.isMember(MEMBER_USER_ID, PROJECT_ID)).thenReturn(true);
		when(dao.isMember(OTHER_USER_ID, PROJECT_ID)).thenReturn(false);
		when(dao.findProjectIdForVersion(PROJECT_VERSION_ID)).thenReturn(PROJECT_ID);
		when(dao.findProjectVersionIdForProcessModel(PROCESS_MODEL_ID)).thenReturn(PROJECT_VERSION_ID);
		when(dao.findProjectVersionIdForProcessConnection(PROCESS_CONNECTION_ID)).thenReturn(PROJECT_VERSION_ID);
		when(dao.findProjectVersionIdForDataStoreConnection(DATA_STORE_CONNECTION_ID)).thenReturn(PROJECT_VERSION_ID);
	}

	@Test
	void testVerifyAccessToProject_Member() {
		assertDoesNotThrow(() -> repository.verifyAccessToProject(MEMBER_USER_ID, PROJECT_ID));
	}

	@Test
	void testVerifyAccessToProject_OtherUser_Forbidden() {
		assertThrows(AccessDeniedException.class,
				() -> repository.verifyAccessToProject(OTHER_USER_ID, PROJECT_ID));
	}

	@Test
	void testVerifyAccessToProject_Unknown_NotFound() {
		assertThrows(NoResultException.class,
				() -> repository.verifyAccessToProject(MEMBER_USER_ID, UNKNOWN_ID));
	}

	@Test
	void testVerifyAccessToProjectVersion_Member() {
		assertDoesNotThrow(() -> repository.verifyAccessToProjectVersion(MEMBER_USER_ID, PROJECT_VERSION_ID));
	}

	@Test
	void testVerifyAccessToProjectVersion_OtherUser_Forbidden() {
		assertThrows(AccessDeniedException.class,
				() -> repository.verifyAccessToProjectVersion(OTHER_USER_ID, PROJECT_VERSION_ID));
	}

	@Test
	void testVerifyAccessToProjectVersion_Unknown_NotFound() {
		assertThrows(NoResultException.class,
				() -> repository.verifyAccessToProjectVersion(MEMBER_USER_ID, UNKNOWN_ID));
	}

	@Test
	void testVerifyAccessToProcessModel_Member() {
		assertDoesNotThrow(() -> repository.verifyAccessToProcessModel(MEMBER_USER_ID, PROCESS_MODEL_ID));
	}

	@Test
	void testVerifyAccessToProcessModel_OtherUser_Forbidden() {
		assertThrows(AccessDeniedException.class,
				() -> repository.verifyAccessToProcessModel(OTHER_USER_ID, PROCESS_MODEL_ID));
	}

	@Test
	void testVerifyAccessToProcessModel_Unknown_NotFound() {
		assertThrows(NoResultException.class,
				() -> repository.verifyAccessToProcessModel(MEMBER_USER_ID, UNKNOWN_ID));
	}

	@Test
	void testVerifyAccessToProcessConnection_Member() {
		assertDoesNotThrow(() -> repository.verifyAccessToProcessConnection(MEMBER_USER_ID, PROCESS_CONNECTION_ID));
	}

	@Test
	void testVerifyAccessToProcessConnection_OtherUser_Forbidden() {
		assertThrows(AccessDeniedException.class,
				() -> repository.verifyAccessToProcessConnection(OTHER_USER_ID, PROCESS_CONNECTION_ID));
	}

	@Test
	void testVerifyAccessToProcessConnection_Unknown_NotFound() {
		assertThrows(NoResultException.class,
				() -> repository.verifyAccessToProcessConnection(MEMBER_USER_ID, UNKNOWN_ID));
	}

	@Test
	void testVerifyAccessToDataStoreConnection_Member() {
		assertDoesNotThrow(
				() -> repository.verifyAccessToDataStoreConnection(MEMBER_USER_ID, DATA_STORE_CONNECTION_ID));
	}

	@Test
	void testVerifyAccessToDataStoreConnection_OtherUser_Forbidden() {
		assertThrows(AccessDeniedException.class,
				() -> repository.verifyAccessToDataStoreConnection(OTHER_USER_ID, DATA_STORE_CONNECTION_ID));
	}

	@Test
	void testVerifyAccessToDataStoreConnection_Unknown_NotFound() {
		assertThrows(NoResultException.class,
				() -> repository.verifyAccessToDataStoreConnection(MEMBER_USER_ID, UNKNOWN_ID));
	}
}
