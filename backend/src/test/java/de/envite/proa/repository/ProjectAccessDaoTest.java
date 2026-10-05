package de.envite.proa.repository;

import de.envite.proa.entities.project.ProjectRole;
import de.envite.proa.repository.project.ProjectAccessDao;
import de.envite.proa.repository.tables.DataStoreConnectionTable;
import de.envite.proa.repository.tables.ProcessConnectionTable;
import de.envite.proa.repository.tables.ProcessModelTable;
import de.envite.proa.repository.tables.ProjectTable;
import de.envite.proa.repository.tables.ProjectUserRelationTable;
import de.envite.proa.repository.tables.ProjectVersionTable;
import de.envite.proa.repository.tables.UserTable;
import io.quarkus.test.junit.QuarkusTest;
import jakarta.inject.Inject;
import jakarta.persistence.EntityManager;
import jakarta.transaction.Transactional;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;

@QuarkusTest
class ProjectAccessDaoTest {

	private static final String MEMBER_EMAIL = "member@example.com";
	private static final String OTHER_USER_EMAIL = "other@example.com";
	private static final String PROJECT_NAME = "Project 1";
	private static final String VERSION_NAME = "Version 1";
	private static final String PROCESS_MODEL_NAME = "Process Model 1";
	private static final Long UNKNOWN_ID = 99999L;

	@Inject
	EntityManager em;

	@Inject
	ProjectAccessDao projectAccessDao;

	private UserTable member;
	private UserTable otherUser;
	private ProjectTable project;
	private ProjectVersionTable projectVersion;
	private ProcessModelTable processModel;
	private ProcessConnectionTable processConnection;
	private DataStoreConnectionTable dataStoreConnection;

	@BeforeEach
	@Transactional
	void setUp() {
		member = new UserTable();
		member.setEmail(MEMBER_EMAIL);
		em.persist(member);

		otherUser = new UserTable();
		otherUser.setEmail(OTHER_USER_EMAIL);
		em.persist(otherUser);

		project = new ProjectTable();
		project.setName(PROJECT_NAME);
		em.persist(project);

		projectVersion = new ProjectVersionTable();
		projectVersion.setName(VERSION_NAME);
		projectVersion.setProject(project);
		em.persist(projectVersion);

		ProjectUserRelationTable relation = new ProjectUserRelationTable();
		relation.setProject(project);
		relation.setUser(member);
		relation.setRole(ProjectRole.OWNER);
		em.persist(relation);

		processModel = new ProcessModelTable();
		processModel.setName(PROCESS_MODEL_NAME);
		processModel.setProject(projectVersion);
		em.persist(processModel);

		processConnection = new ProcessConnectionTable();
		processConnection.setCallingProcess(processModel);
		processConnection.setCalledProcess(processModel);
		processConnection.setProject(projectVersion);
		em.persist(processConnection);

		dataStoreConnection = new DataStoreConnectionTable();
		dataStoreConnection.setProcess(processModel);
		dataStoreConnection.setProject(projectVersion);
		em.persist(dataStoreConnection);
	}

	@AfterEach
	@Transactional
	void cleanup() {
		em.createNativeQuery("DELETE FROM DataStoreConnectionTable").executeUpdate();
		em.createNativeQuery("DELETE FROM ProcessConnectionTable").executeUpdate();
		em.createNativeQuery("DELETE FROM ProcessModelTable").executeUpdate();
		em.createNativeQuery("DELETE FROM ProjectUserRelationTable").executeUpdate();
		em.createNativeQuery("DELETE FROM ProjectVersionTable").executeUpdate();
		em.createNativeQuery("DELETE FROM ProjectTable").executeUpdate();
		em.createNativeQuery("DELETE FROM UserTable").executeUpdate();
	}

	@Test
	@Transactional
	void testExistsProject() {
		assertTrue(projectAccessDao.existsProject(project.getId()));
		assertFalse(projectAccessDao.existsProject(UNKNOWN_ID));
	}

	@Test
	@Transactional
	void testIsMember_Member() {
		assertTrue(projectAccessDao.isMember(member.getId(), project.getId()));
	}

	@Test
	@Transactional
	void testIsMember_OtherUser() {
		assertFalse(projectAccessDao.isMember(otherUser.getId(), project.getId()));
	}

	@Test
	@Transactional
	void testFindProjectIdForVersion() {
		assertEquals(project.getId(), projectAccessDao.findProjectIdForVersion(projectVersion.getId()));
	}

	@Test
	@Transactional
	void testFindProjectIdForVersion_Unknown() {
		assertNull(projectAccessDao.findProjectIdForVersion(UNKNOWN_ID));
	}

	@Test
	@Transactional
	void testFindProjectVersionIdForProcessModel() {
		assertEquals(projectVersion.getId(),
				projectAccessDao.findProjectVersionIdForProcessModel(processModel.getId()));
	}

	@Test
	@Transactional
	void testFindProjectVersionIdForProcessModel_Unknown() {
		assertNull(projectAccessDao.findProjectVersionIdForProcessModel(UNKNOWN_ID));
	}

	@Test
	@Transactional
	void testFindProjectVersionIdForProcessConnection() {
		assertEquals(projectVersion.getId(),
				projectAccessDao.findProjectVersionIdForProcessConnection(processConnection.getId()));
	}

	@Test
	@Transactional
	void testFindProjectVersionIdForProcessConnection_Unknown() {
		assertNull(projectAccessDao.findProjectVersionIdForProcessConnection(UNKNOWN_ID));
	}

	@Test
	@Transactional
	void testFindProjectVersionIdForDataStoreConnection() {
		assertEquals(projectVersion.getId(),
				projectAccessDao.findProjectVersionIdForDataStoreConnection(dataStoreConnection.getId()));
	}

	@Test
	@Transactional
	void testFindProjectVersionIdForDataStoreConnection_Unknown() {
		assertNull(projectAccessDao.findProjectVersionIdForDataStoreConnection(UNKNOWN_ID));
	}
}
