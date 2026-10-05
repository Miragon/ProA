package de.envite.proa.usecases;

import de.envite.proa.entities.process.ProcessInformation;
import de.envite.proa.entities.process.ProcessType;
import de.envite.proa.entities.project.Project;
import de.envite.proa.repository.project.ProjectRepositoryImpl;
import de.envite.proa.usecases.processmodel.ProcessModelUsecase;
import de.envite.proa.usecases.processmodel.exceptions.CantReplaceWithCollaborationException;
import io.quarkus.test.junit.QuarkusTest;
import jakarta.inject.Inject;
import jakarta.persistence.EntityManager;
import jakarta.transaction.Transactional;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Runs the replace flows of {@link ProcessModelUsecase} against the real BPMN parser and
 * database. Replacing a participant (or re-uploading a collaboration, which replaces its
 * participants) runs in a single transaction, so the parent/child relation must be consistent
 * on both sides within one persistence context - otherwise the deletion of the replaced model
 * cascades into the collaboration and the freshly saved model.
 */
@QuarkusTest
class ProcessModelReplaceIntegrationTest {

	private static final String COLLABORATION_BPMN = "collaboration-alpha-beta.bpmn";
	private static final String PROCESS_ALPHA_BPMN = "process-alpha.bpmn";
	private static final String DUPLICATE_PARTICIPANT_NAMES_BPMN = "collaboration-duplicate-participant-names.bpmn";
	private static final String COLLABORATION_NAME = "Alpha and Beta";
	private static final String ALPHA = "Alpha";
	private static final String BETA = "Beta";

	@Inject
	ProcessModelUsecase processModelUsecase;

	@Inject
	ProjectRepositoryImpl projectRepository;

	@Inject
	EntityManager entityManager;

	@Test
	void testReplaceParticipant_KeepsCollaborationAndNewModel() throws Exception {
		// Arrange
		Long versionId = createProjectVersion();
		Long collaborationId = processModelUsecase.saveProcessModel(versionId, COLLABORATION_NAME,
				readResource(COLLABORATION_BPMN), null, true);
		Long alphaId = findByName(versionId, ALPHA).getId();
		Long betaId = findByName(versionId, BETA).getId();

		// Act
		Long newAlphaId = processModelUsecase.replaceProcessModel(versionId, alphaId, ALPHA,
				readResource(PROCESS_ALPHA_BPMN), null);

		// Assert
		List<ProcessInformation> processes = processModelUsecase.getProcessInformation(versionId);
		assertThat(processes)//
				.extracting(ProcessInformation::getId)//
				.containsExactlyInAnyOrder(collaborationId, betaId, newAlphaId);
		assertThat(findById(processes, collaborationId).getChildrenIds())//
				.containsExactlyInAnyOrder(betaId, newAlphaId);
	}

	@Test
	void testReuploadCollaboration_KeepsNewlyUploadedModels() throws CantReplaceWithCollaborationException {
		// Arrange
		Long versionId = createProjectVersion();
		processModelUsecase.saveProcessModel(versionId, COLLABORATION_NAME, readResource(COLLABORATION_BPMN), null,
				true);
		Long oldAlphaId = findByName(versionId, ALPHA).getId();
		Long oldBetaId = findByName(versionId, BETA).getId();

		// Act
		Long newCollaborationId = processModelUsecase.saveProcessModel(versionId, COLLABORATION_NAME,
				readResource(COLLABORATION_BPMN), null, true);

		// Assert: the participants were replaced, nothing of the new upload was deleted
		List<ProcessInformation> processes = processModelUsecase.getProcessInformation(versionId);
		List<ProcessInformation> participants = processes//
				.stream()//
				.filter(process -> process.getProcessType() == ProcessType.PARTICIPANT)//
				.toList();

		assertThat(processes).extracting(ProcessInformation::getId).contains(newCollaborationId);
		assertThat(participants)//
				.extracting(ProcessInformation::getProcessName)//
				.containsExactlyInAnyOrder(ALPHA, BETA);
		assertThat(participants)//
				.extracting(ProcessInformation::getId)//
				.doesNotContain(oldAlphaId, oldBetaId);
		List<Long> allChildIds = processes//
				.stream()//
				.flatMap(process -> process.getChildrenIds().stream())//
				.toList();
		assertThat(allChildIds).containsAll(participants.stream().map(ProcessInformation::getId).toList());
	}

	@Test
	void testUploadCollaborationWithDuplicateParticipantNames_KeepsCollaboration()
			throws CantReplaceWithCollaborationException {
		// Arrange
		Long versionId = createProjectVersion();

		// Act: the second participant replaces the first one (same name) within the upload
		Long collaborationId = processModelUsecase.saveProcessModel(versionId, "Gamma collaboration",
				readResource(DUPLICATE_PARTICIPANT_NAMES_BPMN), null, true);

		// Assert
		List<ProcessInformation> processes = processModelUsecase.getProcessInformation(versionId);
		List<ProcessInformation> participants = processes//
				.stream()//
				.filter(process -> process.getProcessType() == ProcessType.PARTICIPANT)//
				.toList();
		assertThat(participants).hasSize(1);
		ProcessInformation participant = participants.getFirst();
		assertThat(processes)//
				.extracting(ProcessInformation::getId)//
				.containsExactlyInAnyOrder(collaborationId, participant.getId());
		assertThat(findById(processes, collaborationId).getChildrenIds()).containsExactly(participant.getId());
	}

	private Long createProjectVersion() {
		Project project = projectRepository.createProject("Replace Project", "1.0");
		return project.getVersions().stream().findFirst().orElseThrow().getId();
	}

	private ProcessInformation findByName(Long versionId, String name) {
		return processModelUsecase//
				.getProcessInformation(versionId)//
				.stream()//
				.filter(process -> name.equals(process.getProcessName()))//
				.findFirst()//
				.orElseThrow();
	}

	private ProcessInformation findById(List<ProcessInformation> processes, Long id) {
		return processes.stream().filter(process -> id.equals(process.getId())).findFirst().orElseThrow();
	}

	private String readResource(String name) {
		try (InputStream is = getClass().getClassLoader().getResourceAsStream(name)) {
			return new String(is.readAllBytes(), StandardCharsets.UTF_8);
		} catch (IOException e) {
			throw new IllegalStateException(e);
		}
	}

	/**
	 * There is no quarkus feature to clean up the database. Collaborations leave message
	 * flows and parent/child relations behind that the cleanup of other test classes does not
	 * remove, so clean up before and after each test.
	 */
	@BeforeEach
	@AfterEach
	@Transactional
	void cleanupDatabase() {
		entityManager.createNativeQuery("DELETE FROM MessageFlowTable").executeUpdate();
		entityManager.createNativeQuery("DELETE FROM processmodelrelations").executeUpdate();
		entityManager.createNativeQuery("DELETE FROM ProcessEventTable").executeUpdate();
		entityManager.createNativeQuery("DELETE FROM CallActivityTable").executeUpdate();
		entityManager.createNativeQuery("DELETE FROM ProcessConnectionTable").executeUpdate();
		entityManager.createNativeQuery("DELETE FROM DataStoreConnectionTable").executeUpdate();
		entityManager.createNativeQuery("DELETE FROM ProcessDataStoreTable").executeUpdate();
		entityManager.createNativeQuery("DELETE FROM DataStoreTable").executeUpdate();
		entityManager.createNativeQuery("DELETE FROM ProcessModelTable").executeUpdate();
		entityManager.createNativeQuery("DELETE FROM ProjectUserRelationTable").executeUpdate();
		entityManager.createNativeQuery("DELETE FROM ProjectInvitationTable").executeUpdate();
		entityManager.createNativeQuery("DELETE FROM ProjectVersionTable").executeUpdate();
		entityManager.createNativeQuery("DELETE FROM ProjectTable").executeUpdate();
	}
}
