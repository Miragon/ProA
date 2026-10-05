package de.envite.proa.repository;

import de.envite.proa.entities.process.EventType;
import de.envite.proa.entities.process.ProcessEvent;
import de.envite.proa.entities.process.ProcessModel;
import de.envite.proa.entities.project.Project;
import de.envite.proa.repository.processmodel.ProcessmodelRepositoryImpl;
import de.envite.proa.repository.project.ProjectRepositoryImpl;
import io.quarkus.test.junit.QuarkusTest;
import jakarta.inject.Inject;
import jakarta.persistence.EntityManager;
import jakarta.transaction.Transactional;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * Verifies that multi-step repository flows are atomic: when a step in the middle of
 * {@link ProcessmodelRepositoryImpl#saveProcessModel} fails, the rows written by earlier
 * steps must be rolled back.
 */
@QuarkusTest
class TransactionalRollbackTest {

	private static final String PROJECT_NAME = "Rollback Project";
	private static final String PROJECT_VERSION = "1.0";
	private static final String PROCESS_MODEL_NAME = "RollbackProcessModel";
	private static final String START_EVENT_ID = "startEventId";
	private static final String START_EVENT_LABEL = "start event label";
	private static final String INVALID_EVENT_ID = "invalidEventId";
	private static final String INVALID_EVENT_LABEL = "invalid event label";

	@Inject
	ProcessmodelRepositoryImpl processModelRepository;

	@Inject
	ProjectRepositoryImpl projectRepository;

	@Inject
	EntityManager entityManager;

	@Test
	void testSaveProcessModel_FailingEventConnection_RollsBackProcessModel() {
		// Arrange
		Project project = projectRepository.createProject(PROJECT_NAME, PROJECT_VERSION);
		Long projectVersionId = project.getVersions().stream().findFirst().get().getId();

		ProcessEvent startEvent = new ProcessEvent();
		startEvent.setElementId(START_EVENT_ID);
		startEvent.setLabel(START_EVENT_LABEL);
		startEvent.setEventType(EventType.START);

		// The INVALID event type makes connectEvents fail with an IllegalArgumentException
		// after the process model (and possibly connections for other events) have already
		// been written.
		ProcessEvent invalidEvent = new ProcessEvent();
		invalidEvent.setElementId(INVALID_EVENT_ID);
		invalidEvent.setLabel(INVALID_EVENT_LABEL);
		invalidEvent.setEventType(EventType.INVALID);

		ProcessModel model = new ProcessModel();
		model.setName(PROCESS_MODEL_NAME);
		model.setEvents(Set.of(startEvent, invalidEvent));

		// Act
		assertThatThrownBy(() -> processModelRepository.saveProcessModel(projectVersionId, model))
				.isInstanceOf(IllegalArgumentException.class);

		// Assert: no half-written rows survive the failed save
		assertThat(countRows("ProcessModelTable")).isZero();
		assertThat(countRows("ProcessEventTable")).isZero();
		assertThat(countRows("ProcessConnectionTable")).isZero();
	}

	private Long countRows(String entityName) {
		return entityManager
				.createQuery("SELECT COUNT(e) FROM " + entityName + " e", Long.class)
				.getSingleResult();
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
