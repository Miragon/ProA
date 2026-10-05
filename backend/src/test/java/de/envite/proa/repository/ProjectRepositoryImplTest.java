package de.envite.proa.repository;

import de.envite.proa.entities.project.AccessDeniedException;
import de.envite.proa.entities.project.AddContributorResult;
import de.envite.proa.entities.project.NoResultException;
import de.envite.proa.entities.project.Project;
import de.envite.proa.entities.project.ProjectInvitation;
import de.envite.proa.entities.project.ProjectRole;
import de.envite.proa.entities.project.ProjectVersion;
import de.envite.proa.repository.project.ProjectDao;
import de.envite.proa.repository.project.ProjectInvitationDao;
import de.envite.proa.repository.project.ProjectRepositoryImpl;
import de.envite.proa.repository.tables.ProjectInvitationTable;
import de.envite.proa.repository.tables.ProjectTable;
import de.envite.proa.repository.tables.ProjectUserRelationTable;
import de.envite.proa.repository.tables.ProjectVersionTable;
import de.envite.proa.repository.tables.UserTable;
import de.envite.proa.repository.user.UserDao;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.MockitoAnnotations;

import java.time.LocalDateTime;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

class ProjectRepositoryImplTest {

	private static final Long PROJECT_ID = 1L;
	private static final String PROJECT_NAME = "Test Project";
	private static final String PROJECT_VERSION = "1.0";
	private static final Long USER_ID = 1L;
	private static final Long CONTRIBUTOR_ID = 2L;
	private static final Long INVITATION_ID = 10L;
	private static final String CONTRIBUTOR_EMAIL = "contributor@example.com";
	private static final String UNNORMALIZED_EMAIL = "  Contributor@Example.COM ";

	@InjectMocks
	ProjectRepositoryImpl projectRepository;

	@Mock
	ProjectDao projectDao;

	@Mock
	UserDao userDao;

	@Mock
	ProjectInvitationDao invitationDao;

	@BeforeEach
	void setUp() {
		MockitoAnnotations.openMocks(this);
	}

	private ProjectTable projectOwnedByUser() {
		UserTable owner = new UserTable();
		owner.setId(USER_ID);

		ProjectUserRelationTable ownerRelation = new ProjectUserRelationTable();
		ownerRelation.setUser(owner);
		ownerRelation.setRole(ProjectRole.OWNER);

		ProjectTable projectTable = new ProjectTable();
		projectTable.setId(PROJECT_ID);
		projectTable.getUserRelations().add(ownerRelation);
		ownerRelation.setProject(projectTable);
		return projectTable;
	}

	@Test
	void testCreateProject() {
		doNothing().when(projectDao).persist(any(ProjectTable.class));

		Project project = projectRepository.createProject(PROJECT_NAME, PROJECT_VERSION);

		assertNotNull(project);
		assertEquals(PROJECT_NAME, project.getName());

		verify(projectDao).persist(any(ProjectTable.class));
	}

	@Test
	void testCreateProjectWithUser() {
		UserTable user = new UserTable();
		user.setId(USER_ID);

		when(userDao.findById(USER_ID)).thenReturn(user);
		doNothing().when(projectDao).persist(any(ProjectVersionTable.class));

		Project project = projectRepository.createProject(USER_ID, PROJECT_NAME, PROJECT_VERSION);

		assertNotNull(project);
		assertEquals(PROJECT_NAME, project.getName());

		ArgumentCaptor<ProjectTable> projectCatpor =  ArgumentCaptor.forClass(ProjectTable.class);
		verify(projectDao).persist(projectCatpor.capture());
		
		assertThat(projectCatpor.getValue().getName()).isEqualTo(PROJECT_NAME);
		assertThat(projectCatpor.getValue().getCreatedAt()).isEqualTo(project.getCreatedAt());
		assertThat(projectCatpor.getValue().getModifiedAt()).isEqualTo(project.getModifiedAt());
		assertThat(projectCatpor.getValue().getUserRelations().stream().findFirst().get().getUser().getId()).isEqualTo(USER_ID);
		assertThat(projectCatpor.getValue().getUserRelations().stream().findFirst().get().getRole()).isEqualTo(ProjectRole.OWNER);
	}

	@Test
	void testGetProjects() {
		ProjectTable projectTable = new ProjectTable();
		projectTable.setId(PROJECT_ID);
		when(projectDao.getProjectsWithVersionsAndContributors()).thenReturn(List.of(projectTable));

		List<Project> projects = projectRepository.getProjects();

		assertFalse(projects.isEmpty());
		assertTrue(projects.stream().anyMatch(p -> p.getId().equals(projectTable.getId())));

		verify(projectDao).getProjectsWithVersionsAndContributors();
	}

	@Test
	void testGetProjectsForUser() {

		ProjectTable projectTable = new ProjectTable();
		projectTable.setId(PROJECT_ID);

		when(projectDao.getAllProjectsForUserWithVersionsAndContributors(any())).thenReturn(List.of(projectTable));

		List<Project> projects = projectRepository.getProjects(USER_ID);
		assertFalse(projects.isEmpty());
		assertTrue(projects.stream().anyMatch(p -> p.getId().equals(projectTable.getId())));

		ArgumentCaptor<UserTable> userCaptor = ArgumentCaptor.forClass(UserTable.class);
		verify(projectDao).getAllProjectsForUserWithVersionsAndContributors(userCaptor.capture());
		assertEquals(USER_ID, userCaptor.getValue().getId());
	}

	@Test
	void testGetProjectById() {
		ProjectTable projectTable = new ProjectTable();
		when(projectDao.findByIdWithVersionsAndContributors(projectTable.getId())).thenReturn(projectTable);

		Project retrievedProject = projectRepository.getProject(projectTable.getId());
		assertNotNull(retrievedProject);
		assertEquals(projectTable.getId(), retrievedProject.getId());

		verify(projectDao).findByIdWithVersionsAndContributors(projectTable.getId());
	}

	@Test
	void testGetProjectById_NotFound() {
		when(projectDao.findByIdWithVersionsAndContributors(PROJECT_ID)).thenReturn(null);

		assertThrows(NoResultException.class, () -> projectRepository.getProject(PROJECT_ID));

		verify(projectDao).findByIdWithVersionsAndContributors(PROJECT_ID);
	}

	@Test
	void testGetProjectByUserAndId() {

		ProjectTable projectTable = new ProjectTable();
		projectTable.setId(PROJECT_ID);

		UserTable user = new UserTable();
		user.setId(USER_ID);
		
		ProjectUserRelationTable relation = new ProjectUserRelationTable();
		relation.setUser(user);
		
		projectTable.getUserRelations().add(relation);

		when(projectDao.findByIdWithVersionsAndContributors(projectTable.getId())).thenReturn(projectTable);

		Project retrievedProject = projectRepository.getProject(USER_ID, projectTable.getId());
		
		assertNotNull(retrievedProject);
		assertEquals(projectTable.getId(), retrievedProject.getId());

		verify(projectDao).findByIdWithVersionsAndContributors(projectTable.getId());
	}

	@Test
	void testGetProjectByUserAndId_Forbidden() {

		ProjectTable projectTable = new ProjectTable();
		projectTable.setId(PROJECT_ID);

		when(projectDao.findByIdWithVersionsAndContributors(PROJECT_ID)).thenReturn(projectTable);

		assertThrows(AccessDeniedException.class,
				() -> projectRepository.getProject(USER_ID, projectTable.getId()));
	}

	@Test
	void testGetProjectByUserAndId_NotFound() {
		when(projectDao.findByIdWithVersionsAndContributors(PROJECT_ID)).thenReturn(null);

		NoResultException exception = assertThrows(NoResultException.class,
				() -> projectRepository.getProject(USER_ID, PROJECT_ID));

		assertEquals("Project not found", exception.getMessage());
		verify(projectDao).findByIdWithVersionsAndContributors(PROJECT_ID);
	}

	@Test
	void testAddVersionWithUser_UnknownProject_NotFound() {
		when(projectDao.findByIdWithVersionsAndContributors(PROJECT_ID)).thenReturn(null);

		NoResultException exception = assertThrows(NoResultException.class,
				() -> projectRepository.addVersion(USER_ID, PROJECT_ID, PROJECT_VERSION));

		assertEquals("Project not found", exception.getMessage());
		verify(projectDao, never()).persist(any(ProjectVersionTable.class));
	}

	@Test
	void testAddVersionWithUser_NotOwner_Forbidden() {
		ProjectTable projectTable = new ProjectTable();
		projectTable.setId(PROJECT_ID);

		when(projectDao.findByIdWithVersionsAndContributors(PROJECT_ID)).thenReturn(projectTable);

		assertThrows(AccessDeniedException.class,
				() -> projectRepository.addVersion(USER_ID, PROJECT_ID, PROJECT_VERSION));

		verify(projectDao, never()).persist(any(ProjectVersionTable.class));
	}

	@Test
	void testAddVersionWithUser() {
		UserTable user = new UserTable();
		user.setId(USER_ID);

		ProjectUserRelationTable relation = new ProjectUserRelationTable();
		relation.setUser(user);
		relation.setRole(ProjectRole.OWNER);

		ProjectTable projectTable = new ProjectTable();
		projectTable.setId(PROJECT_ID);
		projectTable.getUserRelations().add(relation);

		when(projectDao.findByIdWithVersionsAndContributors(PROJECT_ID)).thenReturn(projectTable);

		ProjectVersion version = projectRepository.addVersion(USER_ID, PROJECT_ID, PROJECT_VERSION);

		assertNotNull(version);
		assertEquals(PROJECT_VERSION, version.getName());
		verify(projectDao).persist(any(ProjectVersionTable.class));
		verify(projectDao).merge(projectTable);
	}

	@Test
	void testAddVersion_UnknownProject_NotFound() {
		when(projectDao.findByIdWithVersionsAndContributors(PROJECT_ID)).thenReturn(null);

		NoResultException exception = assertThrows(NoResultException.class,
				() -> projectRepository.addVersion(PROJECT_ID, PROJECT_VERSION));

		assertEquals("Project not found", exception.getMessage());
		verify(projectDao, never()).persist(any(ProjectVersionTable.class));
	}

	@Test
	void testAddContributor_ExistingUser_AddsMemberImmediately() {
		ProjectTable projectTable = projectOwnedByUser();
		when(projectDao.findByIdWithContributors(PROJECT_ID)).thenReturn(projectTable);

		UserTable contributor = new UserTable();
		contributor.setId(CONTRIBUTOR_ID);
		when(userDao.findByEmail(CONTRIBUTOR_EMAIL)).thenReturn(contributor);

		AddContributorResult result = projectRepository.addContributor(USER_ID, PROJECT_ID, UNNORMALIZED_EMAIL);

		assertEquals(AddContributorResult.Status.MEMBER_ADDED, result.getStatus());
		assertNull(result.getInvitation());

		// The lookup happens with the normalized e-mail
		verify(userDao).findByEmail(CONTRIBUTOR_EMAIL);

		ArgumentCaptor<ProjectUserRelationTable> captor = ArgumentCaptor.forClass(ProjectUserRelationTable.class);
		verify(projectDao).persistProjectMember(captor.capture());
		assertEquals(CONTRIBUTOR_ID, captor.getValue().getUser().getId());
		assertEquals(ProjectRole.COLLABORATEUR, captor.getValue().getRole());
		verify(invitationDao, never()).persist(any());
	}

	@Test
	void testAddContributor_AlreadyMember_Idempotent() {
		ProjectTable projectTable = projectOwnedByUser();
		UserTable contributor = new UserTable();
		contributor.setId(CONTRIBUTOR_ID);
		ProjectUserRelationTable existingRelation = new ProjectUserRelationTable();
		existingRelation.setUser(contributor);
		existingRelation.setRole(ProjectRole.COLLABORATEUR);
		projectTable.getUserRelations().add(existingRelation);

		when(projectDao.findByIdWithContributors(PROJECT_ID)).thenReturn(projectTable);
		when(userDao.findByEmail(CONTRIBUTOR_EMAIL)).thenReturn(contributor);

		AddContributorResult result = projectRepository.addContributor(USER_ID, PROJECT_ID, CONTRIBUTOR_EMAIL);

		assertEquals(AddContributorResult.Status.MEMBER_ADDED, result.getStatus());
		verify(projectDao, never()).persistProjectMember(any());
		verify(invitationDao, never()).persist(any());
	}

	@Test
	void testAddContributor_UnknownEmail_StoresPendingInvitation() {
		ProjectTable projectTable = projectOwnedByUser();
		when(projectDao.findByIdWithContributors(PROJECT_ID)).thenReturn(projectTable);
		when(userDao.findByEmail(CONTRIBUTOR_EMAIL)).thenReturn(null);
		when(invitationDao.findByEmailAndProject(CONTRIBUTOR_EMAIL, PROJECT_ID)).thenReturn(null);
		when(invitationDao.persist(any(ProjectInvitationTable.class))).thenAnswer(invocation -> {
			ProjectInvitationTable invitation = invocation.getArgument(0);
			invitation.setId(INVITATION_ID);
			return invitation;
		});

		AddContributorResult result = projectRepository.addContributor(USER_ID, PROJECT_ID, UNNORMALIZED_EMAIL);

		assertEquals(AddContributorResult.Status.INVITATION_PENDING, result.getStatus());
		assertNotNull(result.getInvitation());
		assertEquals(INVITATION_ID, result.getInvitation().getId());
		assertEquals(CONTRIBUTOR_EMAIL, result.getInvitation().getEmail());
		assertEquals(ProjectRole.COLLABORATEUR, result.getInvitation().getRole());
		assertEquals(USER_ID, result.getInvitation().getInvitedBy());
		assertNotNull(result.getInvitation().getCreatedAt());

		ArgumentCaptor<ProjectInvitationTable> captor = ArgumentCaptor.forClass(ProjectInvitationTable.class);
		verify(invitationDao).persist(captor.capture());
		assertEquals(CONTRIBUTOR_EMAIL, captor.getValue().getEmail());
		assertEquals(projectTable, captor.getValue().getProject());
		verify(projectDao, never()).persistProjectMember(any());
	}

	@Test
	void testAddContributor_Reinvite_ReturnsExistingInvitation() {
		ProjectTable projectTable = projectOwnedByUser();
		when(projectDao.findByIdWithContributors(PROJECT_ID)).thenReturn(projectTable);
		when(userDao.findByEmail(CONTRIBUTOR_EMAIL)).thenReturn(null);

		ProjectInvitationTable existing = new ProjectInvitationTable();
		existing.setId(INVITATION_ID);
		existing.setEmail(CONTRIBUTOR_EMAIL);
		existing.setProject(projectTable);
		existing.setRole(ProjectRole.COLLABORATEUR);
		existing.setCreatedAt(LocalDateTime.now());
		when(invitationDao.findByEmailAndProject(CONTRIBUTOR_EMAIL, PROJECT_ID)).thenReturn(existing);

		AddContributorResult result = projectRepository.addContributor(USER_ID, PROJECT_ID, CONTRIBUTOR_EMAIL);

		assertEquals(AddContributorResult.Status.INVITATION_PENDING, result.getStatus());
		assertEquals(INVITATION_ID, result.getInvitation().getId());
		verify(invitationDao, never()).persist(any());
	}

	@Test
	void testAddContributor_NotOwner_Forbidden() {
		ProjectTable projectTable = new ProjectTable();
		projectTable.setId(PROJECT_ID);
		when(projectDao.findByIdWithContributors(PROJECT_ID)).thenReturn(projectTable);

		assertThrows(AccessDeniedException.class,
				() -> projectRepository.addContributor(USER_ID, PROJECT_ID, CONTRIBUTOR_EMAIL));

		verify(projectDao, never()).persistProjectMember(any());
		verify(invitationDao, never()).persist(any());
	}

	@Test
	void testAddContributor_UnknownProject_NotFound() {
		when(projectDao.findByIdWithContributors(PROJECT_ID)).thenReturn(null);

		assertThrows(NoResultException.class,
				() -> projectRepository.addContributor(USER_ID, PROJECT_ID, CONTRIBUTOR_EMAIL));
	}

	@Test
	void testGetInvitations_Owner_ReturnsMappedInvitations() {
		ProjectTable projectTable = projectOwnedByUser();
		when(projectDao.findByIdWithContributors(PROJECT_ID)).thenReturn(projectTable);

		ProjectInvitationTable invitation = new ProjectInvitationTable();
		invitation.setId(INVITATION_ID);
		invitation.setEmail(CONTRIBUTOR_EMAIL);
		invitation.setProject(projectTable);
		invitation.setRole(ProjectRole.COLLABORATEUR);
		invitation.setInvitedBy(USER_ID);
		invitation.setCreatedAt(LocalDateTime.now());
		when(invitationDao.findByProject(PROJECT_ID)).thenReturn(List.of(invitation));

		List<ProjectInvitation> invitations = projectRepository.getInvitations(USER_ID, PROJECT_ID);

		assertThat(invitations)//
				.hasSize(1)//
				.extracting("id", "email", "role", "invitedBy")//
				.contains(org.assertj.core.groups.Tuple.tuple(INVITATION_ID, CONTRIBUTOR_EMAIL,
						ProjectRole.COLLABORATEUR, USER_ID));
	}

	@Test
	void testGetInvitations_NotOwner_Forbidden() {
		ProjectTable projectTable = new ProjectTable();
		projectTable.setId(PROJECT_ID);
		when(projectDao.findByIdWithContributors(PROJECT_ID)).thenReturn(projectTable);

		assertThrows(AccessDeniedException.class, () -> projectRepository.getInvitations(USER_ID, PROJECT_ID));
	}

	@Test
	void testRevokeInvitation_Owner_Deletes() {
		ProjectTable projectTable = projectOwnedByUser();
		when(projectDao.findByIdWithContributors(PROJECT_ID)).thenReturn(projectTable);

		ProjectInvitationTable invitation = new ProjectInvitationTable();
		invitation.setId(INVITATION_ID);
		invitation.setProject(projectTable);
		when(invitationDao.findById(INVITATION_ID)).thenReturn(invitation);

		projectRepository.revokeInvitation(USER_ID, PROJECT_ID, INVITATION_ID);

		verify(invitationDao).deleteById(INVITATION_ID);
	}

	@Test
	void testRevokeInvitation_UnknownInvitation_NotFound() {
		ProjectTable projectTable = projectOwnedByUser();
		when(projectDao.findByIdWithContributors(PROJECT_ID)).thenReturn(projectTable);
		when(invitationDao.findById(INVITATION_ID)).thenReturn(null);

		assertThrows(NoResultException.class,
				() -> projectRepository.revokeInvitation(USER_ID, PROJECT_ID, INVITATION_ID));

		verify(invitationDao, never()).deleteById(any());
	}

	@Test
	void testRevokeInvitation_InvitationOfOtherProject_NotFound() {
		ProjectTable projectTable = projectOwnedByUser();
		when(projectDao.findByIdWithContributors(PROJECT_ID)).thenReturn(projectTable);

		ProjectTable otherProject = new ProjectTable();
		otherProject.setId(99L);
		ProjectInvitationTable invitation = new ProjectInvitationTable();
		invitation.setId(INVITATION_ID);
		invitation.setProject(otherProject);
		when(invitationDao.findById(INVITATION_ID)).thenReturn(invitation);

		assertThrows(NoResultException.class,
				() -> projectRepository.revokeInvitation(USER_ID, PROJECT_ID, INVITATION_ID));

		verify(invitationDao, never()).deleteById(any());
	}

	@Test
	void testRevokeInvitation_NotOwner_Forbidden() {
		ProjectTable projectTable = new ProjectTable();
		projectTable.setId(PROJECT_ID);
		when(projectDao.findByIdWithContributors(PROJECT_ID)).thenReturn(projectTable);

		assertThrows(AccessDeniedException.class,
				() -> projectRepository.revokeInvitation(USER_ID, PROJECT_ID, INVITATION_ID));

		verify(invitationDao, never()).deleteById(any());
	}
}
