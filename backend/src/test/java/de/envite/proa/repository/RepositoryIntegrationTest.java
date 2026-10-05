package de.envite.proa.repository;

import de.envite.proa.entities.authentication.Role;
import de.envite.proa.entities.datastore.DataAccess;
import de.envite.proa.entities.process.*;
import de.envite.proa.entities.processmap.ProcessMap;
import de.envite.proa.entities.project.AccessDeniedException;
import de.envite.proa.entities.project.NoResultException;
import de.envite.proa.entities.project.Project;
import de.envite.proa.repository.processmap.ProcessMapRepositoryImpl;
import de.envite.proa.repository.processmodel.ProcessmodelRepositoryImpl;
import de.envite.proa.repository.project.ProjectRepositoryImpl;
import de.envite.proa.repository.tables.UserTable;
import de.envite.proa.repository.user.UserDao;
import io.quarkus.test.junit.QuarkusTest;
import jakarta.inject.Inject;
import jakarta.persistence.EntityManager;
import jakarta.transaction.Transactional;
import jakarta.transaction.UserTransaction;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.time.LocalDateTime;
import java.util.Collections;
import java.util.List;
import java.util.Set;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.*;

@QuarkusTest
class RepositoryIntegrationTest {
	private static final String USER_EMAIL_1 = "email1@example.com";
	private static final String USER_EMAIL_2 = "email2@example.com";
	private static final String DATA_STORE_LABEL = "DataStore Label";
	private static final String DATA_STORE_ID = "dataStoreId";
	private static final String EVENT_LABEL = "common event label";
	private static final String ACTIVITY_LABEL = "Activity Label";
	private static final String PROCESS_MODEL_NAME = "TestProcessModel";
	private static final String EVENT_ID = "EventID";
	private static final String ACTIVITY_ID = "ActivityId";
	private static final String PROCESS_MODEL_NAME_2 = "TestProcessModel2";
	private static final String PROJECT_NAME = "Project Name";
	private static final String PROJECT_VERSION = "1.0";
	private static final String PROJECT_NAME_2 = "Project Name 2";
	private static final String PROJECT_VERSION_2 = "2.0";
	@Inject
	UserDao userDao;

	@Inject
	private EntityManager entityManager;

	@Inject
	private ProcessmodelRepositoryImpl processModelRepository;

	@Inject
	private ProcessMapRepositoryImpl processMapRepository;

	@Inject
	private ProjectRepositoryImpl projectRepository;

	@Inject
	UserTransaction userTransaction;

	@Test
	void testSaveAndGetProcessModel() {

		// Arrange
		ProcessModel model = new ProcessModel();
		model.setName(PROCESS_MODEL_NAME);

		ProcessEvent startEvent = new ProcessEvent();
		startEvent.setElementId(EVENT_ID);
		startEvent.setLabel(EVENT_LABEL);
		startEvent.setEventType(EventType.START);
		model.setEvents(Set.of(startEvent));

		ProcessActivity activity = new ProcessActivity();
		activity.setElementId(ACTIVITY_ID);
		activity.setLabel(ACTIVITY_LABEL);
		model.setCallActivities(Set.of(activity));

		// Act
		Project project = projectRepository.createProject(PROJECT_NAME, PROJECT_VERSION);
		Long projectVersionId = project.getVersions().stream().findFirst().get().getId();
		Long processId = processModelRepository.saveProcessModel(projectVersionId, model);
		ProcessDetails processDetails = processModelRepository.getProcessDetails(processId);

		// Assert
		assertThat(processDetails.getName()).isEqualTo(PROCESS_MODEL_NAME);
		assertThat(processDetails.getStartEvents())//
				.hasSize(1)//
				.extracting("elementId", "label", "eventType")//
				.contains(tuple(EVENT_ID, EVENT_LABEL, EventType.START));
	}

	@Test
	void testGetProcessMap() {

		// Arrange
		ProcessModel model1 = new ProcessModel();
		model1.setName(PROCESS_MODEL_NAME);

		ProcessEvent startEvent = new ProcessEvent();
		startEvent.setElementId(EVENT_ID);
		startEvent.setLabel(EVENT_LABEL);
		startEvent.setEventType(EventType.START);
		model1.setEvents(Set.of(startEvent));

		ProcessModel model2 = new ProcessModel();
		model2.setName(PROCESS_MODEL_NAME_2);

		ProcessEvent endEvent = new ProcessEvent();
		endEvent.setElementId(EVENT_ID);
		endEvent.setLabel(EVENT_LABEL);
		endEvent.setEventType(EventType.END);
		model2.setEvents(Set.of(endEvent));

		ProcessDataStore dataStore = new ProcessDataStore();
		dataStore.setAccess(DataAccess.READ);
		dataStore.setElementId(DATA_STORE_ID);
		dataStore.setLabel(DATA_STORE_LABEL);
		model2.setDataStores(Collections.singletonList(dataStore));

		// Act
		Project project = projectRepository.createProject(PROJECT_NAME, PROJECT_VERSION);
		Long projectVersionId = project.getVersions().stream().findFirst().get().getId();
		Long processId1 = processModelRepository.saveProcessModel(projectVersionId, model1);
		Long processId2 = processModelRepository.saveProcessModel(projectVersionId, model2);

		ProcessMap processMap = processMapRepository.getProcessMap(projectVersionId);

		// Assert
		assertThat(processMap.getProcesses())//
				.hasSize(2)//
				.extracting("id", "name")//
				.contains(tuple(processId1, PROCESS_MODEL_NAME), //
						tuple(processId2, PROCESS_MODEL_NAME_2));

		assertThat(processMap.getConnections())//
				.hasSize(1)//
				.extracting("callingProcessid", "callingElementType", "calledProcessid", "calledElementType", "label")//
				.contains(tuple(processId2, ProcessElementType.END_EVENT, processId1, ProcessElementType.START_EVENT,
						EVENT_LABEL));

		assertThat(processMap.getDataStores())//
				.hasSize(1)//
				.extracting("name")//
				.contains(DATA_STORE_LABEL);

		Long dataStoreId = processMap.getDataStores().get(0).getId();
		assertThat(processMap.getDataStoreConnections())//
				.hasSize(1)//
				.extracting("processid", "dataStoreId", "access")//
				.contains(tuple(processId2, dataStoreId, DataAccess.READ));
	}

	@Test
	void testDeleteProcess() {

		// Arrange
		ProcessModel model1 = new ProcessModel();
		model1.setName(PROCESS_MODEL_NAME);

		ProcessEvent startEvent = new ProcessEvent();
		startEvent.setElementId(EVENT_ID);
		startEvent.setLabel(EVENT_LABEL);
		startEvent.setEventType(EventType.START);
		model1.setEvents(Set.of(startEvent));

		ProcessModel model2 = new ProcessModel();
		model2.setName(PROCESS_MODEL_NAME_2);

		ProcessEvent endEvent = new ProcessEvent();
		endEvent.setElementId(EVENT_ID);
		endEvent.setLabel(EVENT_LABEL);
		endEvent.setEventType(EventType.END);
		model2.setEvents(Set.of(endEvent));

		ProcessDataStore dataStore = new ProcessDataStore();
		dataStore.setAccess(DataAccess.READ);
		dataStore.setElementId(DATA_STORE_ID);
		dataStore.setLabel(DATA_STORE_LABEL);
		model2.setDataStores(Collections.singletonList(dataStore));

		// Act
		Project project = projectRepository.createProject(PROJECT_NAME, PROJECT_VERSION);
		Long projectVersionId = project.getVersions().stream().findFirst().get().getId();
		Long processId1 = processModelRepository.saveProcessModel(projectVersionId, model1);
		Long processId2 = processModelRepository.saveProcessModel(projectVersionId, model2);

		processModelRepository.deleteProcessModel(processId2);

		ProcessMap processMap = processMapRepository.getProcessMap(projectVersionId);

		// Assert
		assertThat(processMap.getProcesses())//
				.hasSize(1)//
				.extracting("id", "name")//
				.contains(tuple(processId1, PROCESS_MODEL_NAME));

		assertThat(processMap.getConnections()).isEmpty();

		assertThat(processMap.getDataStores())//
				.isEmpty();

		assertThat(processMap.getDataStoreConnections()).isEmpty();
	}

	@Test
	void testGetProjects() {

		// Arrange
		Long projectId1 = projectRepository.createProject(PROJECT_NAME, PROJECT_VERSION).getId();
		Long projectId2 = projectRepository.createProject(PROJECT_NAME_2, PROJECT_VERSION_2).getId();

		// Act
		List<Project> projects = projectRepository.getProjects();

		// Assert
		assertThat(projects)//
				.hasSize(2)//
				.extracting("id", "name")//
				.contains(tuple(projectId1, PROJECT_NAME),
						tuple(projectId2, PROJECT_NAME_2));
		assertThat(projects.get(0).getVersions().stream().findFirst().get().getName()).isEqualTo(PROJECT_VERSION);
		assertThat(projects.get(1).getVersions().stream().findFirst().get().getName()).isEqualTo(PROJECT_VERSION_2);
	}

	@Test
	void testGetProject() {

		// Arrange
		Long projectId = projectRepository.createProject(PROJECT_NAME, PROJECT_VERSION).getId();

		// Act
		Project project = projectRepository.getProject(projectId);

		// Assert
		assertThat(project.getId()).isEqualTo(projectId);
		assertThat(project.getName()).isEqualTo(PROJECT_NAME);
	}

	@Test
	void testDeleteProjectVersionsWithoutUser() throws NoResultException {

		// Arrange
		ProcessModel model = new ProcessModel();
		model.setName(PROCESS_MODEL_NAME);

		ProcessDataStore dataStore = new ProcessDataStore();
		dataStore.setAccess(DataAccess.READ);
		dataStore.setElementId(DATA_STORE_ID);
		dataStore.setLabel(DATA_STORE_LABEL);
		model.setDataStores(Collections.singletonList(dataStore));

		Project project = projectRepository.createProject(PROJECT_NAME, PROJECT_VERSION);
		Project project2 = projectRepository.createProject(PROJECT_NAME_2, PROJECT_VERSION_2);
		Long projectVersionId = project.getVersions().stream().findFirst().get().getId();
		Long projectVersionId2 = project2.getVersions().stream().findFirst().get().getId();
		processModelRepository.saveProcessModel(projectVersionId, model);

		// Act
		projectRepository.removeVersion(project.getId(), projectVersionId);
		projectRepository.removeVersion(project2.getId(), projectVersionId2);

		// Assert
		assertThat(processMapRepository.getProcessMap(projectVersionId).getDataStores()).isEmpty();
		assertThat(processMapRepository.getProcessMap(projectVersionId2).getProcesses()).isEmpty();
		assertThat(projectRepository.getProjects()).isEmpty();
	}

	@Test
	void testDeleteProjectVersionWithoutUserNonExistentProject() {

		// Arrange
		Long nonExistentProjectId = 1L;

		// Act & Assert
		assertThatThrownBy(() -> projectRepository.removeVersion(nonExistentProjectId, nonExistentProjectId))
				.isInstanceOf(NoResultException.class);
	}

	@Test
	void testDeleteProjectVersionWithUser() throws AccessDeniedException, NoResultException {
		// Arrange
		ProcessModel model = new ProcessModel();
		model.setName(PROCESS_MODEL_NAME);

		ProcessDataStore dataStore = new ProcessDataStore();
		dataStore.setAccess(DataAccess.READ);
		dataStore.setElementId(DATA_STORE_ID);
		dataStore.setLabel(DATA_STORE_LABEL);
		model.setDataStores(Collections.singletonList(dataStore));

		Long userId = createUser(USER_EMAIL_1);

		Project project = projectRepository.createProject(userId, PROJECT_NAME, PROJECT_VERSION);
		Long projectVersionId = project.getVersions().stream().findFirst().get().getId();
		processModelRepository.saveProcessModel(projectVersionId, model);

		// Act
		projectRepository.removeVersion(userId, project.getId(), projectVersionId);

		// Assert
		assertThat(processMapRepository.getProcessMap(project.getId()).getDataStores()).isEmpty();
		assertThat(processMapRepository.getProcessMap(project.getId()).getProcesses()).isEmpty();
		assertThat(projectRepository.getProjects(userId)).isEmpty();
	}

	@Test
	void testDeleteProjectVersionWithUserNonExistentProject() {

		// Arrange
		Long userId = 1L;
		Long nonExistentProjectId = 1L;
		Long nonexistendVersionId = 1L;

		// Act & Assert
		assertThatThrownBy(() -> projectRepository.removeVersion(userId, nonExistentProjectId, nonexistendVersionId))
				.isInstanceOf(NoResultException.class);
	}

	@Test
	void testDeleteProjectVersionWithProjectNotBelongingToUser() {
		// Arrange
		Long userId1 = createUser(USER_EMAIL_1);
		Long userId2 = createUser(USER_EMAIL_2);

		Project project = projectRepository.createProject(userId1, PROJECT_NAME, PROJECT_VERSION);

		// Act & Assert
		assertThatThrownBy(() -> projectRepository.removeVersion(userId2, project.getId(), project.getVersions().stream().findFirst().get().getId()))
				.isInstanceOf(AccessDeniedException.class);
		assertThat(projectRepository.getProjects(userId1)).hasSize(1);
	}

	@Test
	void testDeleteNonLastProjectVersionWithUser() throws AccessDeniedException, NoResultException {
		// Arrange
		Long userId = createUser(USER_EMAIL_1);
		Project project = projectRepository.createProject(userId, PROJECT_NAME, PROJECT_VERSION);
		Long firstVersionId = project.getVersions().stream().findFirst().get().getId();
		Long secondVersionId = projectRepository.addVersion(userId, project.getId(), PROJECT_VERSION_2).getId();
		processModelRepository.saveProcessModel(secondVersionId, processModelWithDataStore());

		// Act
		projectRepository.removeVersion(userId, project.getId(), secondVersionId);

		// Assert
		assertThat(projectRepository.getProject(userId, project.getId()).getVersions())//
				.extracting("id")//
				.containsExactly(firstVersionId);
		assertThat(countVersionRows(secondVersionId)).isZero();
		assertThat(countProcessModelRows(secondVersionId)).isZero();
	}

	@Test
	void testDeleteNonLastProjectVersionWithoutUser() throws NoResultException {
		// Arrange
		Project project = projectRepository.createProject(PROJECT_NAME, PROJECT_VERSION);
		Long firstVersionId = project.getVersions().stream().findFirst().get().getId();
		Long secondVersionId = projectRepository.addVersion(project.getId(), PROJECT_VERSION_2).getId();
		processModelRepository.saveProcessModel(secondVersionId, processModelWithDataStore());

		// Act
		projectRepository.removeVersion(project.getId(), secondVersionId);

		// Assert
		assertThat(projectRepository.getProject(project.getId()).getVersions())//
				.extracting("id")//
				.containsExactly(firstVersionId);
		assertThat(countVersionRows(secondVersionId)).isZero();
		assertThat(countProcessModelRows(secondVersionId)).isZero();
	}

	@Test
	void testDeleteProjectVersionOfForeignProjectWithUser() {
		// Arrange: the attacker owns a project, the victim owns another one
		Long attackerId = createUser(USER_EMAIL_1);
		Long victimId = createUser(USER_EMAIL_2);
		Project attackerProject = projectRepository.createProject(attackerId, PROJECT_NAME, PROJECT_VERSION);
		Project victimProject = projectRepository.createProject(victimId, PROJECT_NAME_2, PROJECT_VERSION);
		Long victimFirstVersionId = victimProject.getVersions().stream().findFirst().get().getId();
		Long victimSecondVersionId = projectRepository.addVersion(victimId, victimProject.getId(), PROJECT_VERSION_2)
				.getId();
		processModelRepository.saveProcessModel(victimSecondVersionId, processModelWithDataStore());

		// Act & Assert: owning the project in the path must not allow deleting a foreign version
		assertThatThrownBy(
				() -> projectRepository.removeVersion(attackerId, attackerProject.getId(), victimSecondVersionId))
				.isInstanceOf(NoResultException.class);
		assertThatThrownBy(
				() -> projectRepository.removeVersion(attackerId, attackerProject.getId(), victimFirstVersionId))
				.isInstanceOf(NoResultException.class);

		assertThat(projectRepository.getProject(victimId, victimProject.getId()).getVersions())//
				.extracting("id")//
				.containsExactlyInAnyOrder(victimFirstVersionId, victimSecondVersionId);
		assertThat(countProcessModelRows(victimSecondVersionId)).isOne();
		assertThat(projectRepository.getProjects(attackerId)).hasSize(1);
	}

	@Test
	void testDeleteProjectVersionOfForeignProjectWithoutUser() {
		// Arrange
		Project project = projectRepository.createProject(PROJECT_NAME, PROJECT_VERSION);
		Project otherProject = projectRepository.createProject(PROJECT_NAME_2, PROJECT_VERSION);
		Long otherVersionId = otherProject.getVersions().stream().findFirst().get().getId();

		// Act & Assert
		assertThatThrownBy(() -> projectRepository.removeVersion(project.getId(), otherVersionId))
				.isInstanceOf(NoResultException.class);
		assertThat(projectRepository.getProjects()).hasSize(2);
		assertThat(countVersionRows(otherVersionId)).isOne();
	}

	@Test
	void testConcurrentDeletionOfTheLastTwoVersions_DeletesTheProject() throws Exception {
		// Arrange
		Project project = projectRepository.createProject(PROJECT_NAME, PROJECT_VERSION);
		Long firstVersionId = project.getVersions().stream().findFirst().get().getId();
		Long secondVersionId = projectRepository.addVersion(project.getId(), PROJECT_VERSION_2).getId();

		CountDownLatch firstRemoved = new CountDownLatch(1);
		CountDownLatch commitFirst = new CountDownLatch(1);
		ExecutorService executor = Executors.newFixedThreadPool(2);
		try {
			// Act: the first deletion holds its transaction open while the second one starts
			Future<?> first = executor.submit(() -> {
				userTransaction.begin();
				projectRepository.removeVersion(project.getId(), firstVersionId);
				firstRemoved.countDown();
				commitFirst.await(10, TimeUnit.SECONDS);
				userTransaction.commit();
				return null;
			});
			if (!firstRemoved.await(10, TimeUnit.SECONDS)) {
				first.get(1, TimeUnit.SECONDS); // surfaces the worker's exception
			}
			Future<?> second = executor.submit(() -> {
				userTransaction.begin();
				projectRepository.removeVersion(project.getId(), secondVersionId);
				userTransaction.commit();
				return null;
			});
			// Give the second deletion time to reach the project lock before the first commits
			Thread.sleep(300);
			commitFirst.countDown();
			first.get(10, TimeUnit.SECONDS);
			second.get(10, TimeUnit.SECONDS);
		} finally {
			executor.shutdownNow();
		}

		// Assert: no project without versions is left behind
		assertThat(projectRepository.getProjects()).isEmpty();
	}

	private ProcessModel processModelWithDataStore() {
		ProcessModel model = new ProcessModel();
		model.setName(PROCESS_MODEL_NAME);

		ProcessDataStore dataStore = new ProcessDataStore();
		dataStore.setAccess(DataAccess.READ);
		dataStore.setElementId(DATA_STORE_ID);
		dataStore.setLabel(DATA_STORE_LABEL);
		model.setDataStores(Collections.singletonList(dataStore));
		return model;
	}

	private Long countVersionRows(Long versionId) {
		return entityManager//
				.createQuery("SELECT COUNT(v) FROM ProjectVersionTable v WHERE v.id = :id", Long.class)//
				.setParameter("id", versionId)//
				.getSingleResult();
	}

	private Long countProcessModelRows(Long versionId) {
		return entityManager//
				.createQuery("SELECT COUNT(p) FROM ProcessModelTable p WHERE p.project.id = :id", Long.class)//
				.setParameter("id", versionId)//
				.getSingleResult();
	}

	private Long createUser(String email) {
		UserTable user = new UserTable();
		user.setEmail(email);
		user.setRole(Role.User);
		user.setCreatedAt(LocalDateTime.now());
		return userDao.save(user).getId();
	}

	/**
	 * There is no quarkus feature to clean up the database
	 *
	 * @see <a href="https://stackoverflow.com/questions/71857904/quarkus-clean-h2-db-after-every-test"</a>
	 * @see <a href="https://github.com/quarkusio/quarkus/issues/14240"</a>
	 */
	@BeforeEach
	@Transactional
	void cleanupDatabase() {
		entityManager.createNativeQuery("DELETE FROM ProcessEventTable").executeUpdate();
		entityManager.createNativeQuery("DELETE FROM CallActivityTable").executeUpdate();
		entityManager.createNativeQuery("DELETE FROM ProcessConnectionTable").executeUpdate();
		entityManager.createNativeQuery("DELETE FROM DataStoreConnectionTable").executeUpdate();
		entityManager.createNativeQuery("DELETE FROM ProcessDataStoreTable").executeUpdate();
		entityManager.createNativeQuery("DELETE FROM DataStoreTable").executeUpdate();
		entityManager.createNativeQuery("DELETE FROM ProcessModelTable").executeUpdate();
		entityManager.createNativeQuery("DELETE FROM ProjectUserRelationTable").executeUpdate();
		entityManager.createNativeQuery("DELETE FROM ProjectVersionTable").executeUpdate();
		entityManager.createNativeQuery("DELETE FROM ProjectTable").executeUpdate();
		entityManager.createNativeQuery("DELETE FROM UserTable").executeUpdate();
	}
}
