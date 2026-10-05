package de.envite.proa.repository.project;

import java.time.LocalDateTime;
import java.util.List;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.stream.Collectors;

import de.envite.proa.entities.project.AccessDeniedException;
import de.envite.proa.entities.project.AddContributorResult;
import de.envite.proa.entities.project.NoResultException;
import de.envite.proa.entities.project.Project;
import de.envite.proa.entities.project.ProjectInvitation;
import de.envite.proa.entities.project.ProjectMember;
import de.envite.proa.entities.project.ProjectRole;
import de.envite.proa.entities.project.ProjectVersion;
import de.envite.proa.repository.tables.ProjectInvitationTable;
import de.envite.proa.repository.tables.ProjectTable;
import de.envite.proa.repository.tables.ProjectUserRelationTable;
import de.envite.proa.repository.tables.ProjectVersionTable;
import de.envite.proa.repository.tables.UserTable;
import de.envite.proa.repository.user.UserDao;
import de.envite.proa.usecases.project.ProjectRepository;
import de.envite.proa.util.EmailNormalizer;
import jakarta.enterprise.context.ApplicationScoped;
import jakarta.inject.Inject;
import jakarta.transaction.Transactional;

@ApplicationScoped
@Transactional
public class ProjectRepositoryImpl implements ProjectRepository {

	@Inject
	private ProjectDao projectDao;

	@Inject
	private UserDao userDao;

	@Inject
	private ProjectInvitationDao invitationDao;

	@Inject
	public ProjectRepositoryImpl(ProjectDao dao, UserDao userDao, ProjectInvitationDao invitationDao) {
		this.projectDao = dao;
		this.userDao = userDao;
		this.invitationDao = invitationDao;
	}

	@Override
	public Project createProject(String name, String version) {
		LocalDateTime now = LocalDateTime.now();

		ProjectVersionTable projectVersion = new ProjectVersionTable();
		projectVersion.setName(version);
		projectVersion.setCreatedAt(now);
		projectVersion.setModifiedAt(now);

		ProjectTable project = new ProjectTable();
		project.setName(name);
		project.setCreatedAt(now);
		project.setModifiedAt(now);
		project.getVersions().add(projectVersion);
		
		projectVersion.setProject(project);

		projectDao.persist(project);
		return map(project);
	}

	@Override
	public Project createProject(Long userId, String name, String version) {
		LocalDateTime now = LocalDateTime.now();

		ProjectVersionTable projectVersion = new ProjectVersionTable();
		projectVersion.setName(version);
		projectVersion.setCreatedAt(now);
		projectVersion.setModifiedAt(now);

		ProjectTable project = new ProjectTable();
		project.setName(name);
		project.setCreatedAt(now);
		project.setModifiedAt(now);
		project.getVersions().add(projectVersion);

		projectVersion.setProject(project);

		UserTable user = new UserTable();
		user.setId(userId);
		ProjectUserRelationTable relation = new ProjectUserRelationTable();
		relation.setUser(user);
		relation.setProject(project);
		relation.setRole(ProjectRole.OWNER);
		
		project.getUserRelations().add(relation);
		
		projectDao.persist(project);
		return map(project);
	}

	@Override
	public ProjectVersion addVersion(Long userId, Long projectId, String versionName) {
		ProjectTable project = projectDao.findByIdWithVersionsAndContributors(projectId);
		if (project == null) {
			throw new NoResultException("Project not found");
		}

		List<Long> owners = project//
			.getUserRelations()//
			.stream()//
			.filter(relation -> relation.getRole().equals(ProjectRole.OWNER))//
			.map(relation -> relation.getUser().getId())
			.toList();

		if (!owners.contains(userId)) {
			throw new AccessDeniedException("Not found or Access forbidden");
		}

		return createVersionAndMergeProject(project, versionName);
	}

	@Override
	public ProjectVersion addVersion(Long projectId, String versionName) {
		ProjectTable project = projectDao.findByIdWithVersionsAndContributors(projectId);
		if (project == null) {
			throw new NoResultException("Project not found");
		}
		return createVersionAndMergeProject(project, versionName);
	}

	private ProjectVersion createVersionAndMergeProject(ProjectTable project, String versionName) {
		ProjectVersionTable projectVersion = new ProjectVersionTable();
		projectVersion.setName(versionName);

		LocalDateTime now = LocalDateTime.now();
		projectVersion.setCreatedAt(now);
		projectVersion.setModifiedAt(now);
		projectVersion.setProject(project);
		
		projectDao.persist(projectVersion);

		project.getVersions().add(projectVersion);
		project.setModifiedAt(now);
		projectDao.merge(project);
		return map(projectVersion);
	}

	@Override
	public List<Project> getProjects() {
		return projectDao//
				.getProjectsWithVersionsAndContributors()//
				.stream()//
				.map(project -> map(project))//
				.toList();
	}

	@Override
	public List<Project> getProjects(Long userId) {
		UserTable user = new UserTable();
		user.setId(userId);

		return projectDao//
				.getAllProjectsForUserWithVersionsAndContributors(user)//
				.stream()//
				.map(project -> map(project))//
				.toList();
	}

	@Override
	public Project getProject(Long projectId) {
		ProjectTable project = projectDao.findByIdWithVersionsAndContributors(projectId);
		if (project == null) {
			throw new NoResultException("Project not found");
		}
		return map(project);
	}

	@Override
	public Project getProject(Long userId, Long projectId) {
		ProjectTable project = projectDao.findByIdWithVersionsAndContributors(projectId);
		if (project == null) {
			throw new NoResultException("Project not found");
		}

		List<Long> allowedUsers = project//
				.getUserRelations()//
				.stream()//
				.map(relation -> relation.getUser().getId())
				.toList();
		
		if (!allowedUsers.contains(userId)) {
			throw new AccessDeniedException("Not found or Access forbidden");
		}
		return map(project);
	}

	@Override
	public void removeVersion(Long projectId, Long versionId) throws NoResultException {
		ProjectTable project = findProjectForUpdateOrThrow(projectId);
		removeVersionOfProject(project, versionId);
	}

	@Override
	public void removeVersion(Long userId, Long projectId, Long versionId) throws AccessDeniedException, NoResultException {
		ProjectTable project = findProjectForUpdateOrThrow(projectId);
		validateProjectOwner(project, userId);
		removeVersionOfProject(project, versionId);
	}

	/**
	 * Removes the version, or the entire project if it is the last version. The version must
	 * belong to the given project: otherwise the owner of any project could delete versions of
	 * foreign projects by id. The project must be locked (see {@link #findProjectForUpdateOrThrow})
	 * so that two concurrent deletions cannot both see "more than one version" and leave the
	 * project without any.
	 */
	private void removeVersionOfProject(ProjectTable project, Long versionId) throws NoResultException {
		ProjectVersionTable version = project//
				.getVersions()//
				.stream()//
				.filter(v -> Objects.equals(v.getId(), versionId))//
				.findFirst()//
				.orElseThrow(() -> new NoResultException("Version not found in project"));

		if (project.getVersions().size() == 1) {
			deleteEntireProject(project.getId());
		} else {
			removeVersionFromProject(project, version);
		}
	}

	/**
	 * Invites an e-mail address to the project (ADR-0003): if a local user with that e-mail
	 * exists the membership is created immediately, otherwise a pending invitation is stored.
	 * Idempotent - inviting an existing member or re-inviting the same e-mail is not an error.
	 */
	@Override
	public AddContributorResult addContributor(Long userId, Long projectId, String email)
			throws AccessDeniedException, NoResultException {
		ProjectTable project = findProjectWithContributorsOrThrow(projectId);
		validateProjectOwner(project, userId);
		String normalizedEmail = EmailNormalizer.normalize(email);

		UserTable user = userDao.findByEmail(normalizedEmail);
		if (user != null) {
			boolean alreadyMember = project//
					.getUserRelations()//
					.stream()//
					.anyMatch(relation -> relation.getUser().getId().equals(user.getId()));
			if (!alreadyMember) {
				ProjectUserRelationTable relation = new ProjectUserRelationTable();
				relation.setProject(project);
				relation.setUser(user);
				relation.setRole(ProjectRole.COLLABORATEUR);
				projectDao.persistProjectMember(relation);
			}
			return AddContributorResult.memberAdded();
		}

		ProjectInvitationTable invitation = invitationDao.findByEmailAndProject(normalizedEmail, projectId);
		if (invitation == null) {
			invitation = new ProjectInvitationTable();
			invitation.setEmail(normalizedEmail);
			invitation.setProject(project);
			invitation.setRole(ProjectRole.COLLABORATEUR);
			invitation.setInvitedBy(userId);
			invitation.setCreatedAt(LocalDateTime.now());
			invitationDao.persist(invitation);
		}
		return AddContributorResult.invitationPending(map(invitation));
	}

	@Override
	public List<ProjectInvitation> getInvitations(Long userId, Long projectId)
			throws AccessDeniedException, NoResultException {
		ProjectTable project = findProjectWithContributorsOrThrow(projectId);
		validateProjectOwner(project, userId);
		return invitationDao//
				.findByProject(projectId)//
				.stream()//
				.map(this::map)//
				.toList();
	}

	@Override
	public void revokeInvitation(Long userId, Long projectId, Long invitationId)
			throws AccessDeniedException, NoResultException {
		ProjectTable project = findProjectWithContributorsOrThrow(projectId);
		validateProjectOwner(project, userId);
		ProjectInvitationTable invitation = invitationDao.findById(invitationId);
		if (invitation == null || !Objects.equals(invitation.getProject().getId(), projectId)) {
			throw new NoResultException("Invitation not found with ID: " + invitationId);
		}
		invitationDao.deleteById(invitationId);
	}

	@Override
	public void removeContributor(Long userId, Long projectId, Long contributorId) throws AccessDeniedException, NoResultException {
		ProjectTable project = findProjectWithContributorsOrThrow(projectId);
		validateProjectOwner(project, userId);
		project.getUserRelations().removeIf(relation -> relation.getUser().getId().equals(contributorId));
		project.setModifiedAt(LocalDateTime.now());
		projectDao.merge(project);
	}

	private ProjectTable findProjectWithContributorsOrThrow(Long projectId) throws NoResultException {
		return Optional.ofNullable(projectDao.findByIdWithContributors(projectId))
				.orElseThrow(() -> new NoResultException("Project not found with ID: " + projectId));
	}

	private ProjectTable findProjectForUpdateOrThrow(Long projectId) throws NoResultException {
		return Optional.ofNullable(projectDao.findByIdForUpdate(projectId))
				.orElseThrow(() -> new NoResultException("Project not found with ID: " + projectId));
	}

	private void validateProjectOwner(ProjectTable project, Long userId) throws AccessDeniedException {
		
		List<Long> owners = project//
				.getUserRelations()//
				.stream()//
				.filter(relation -> relation.getRole().equals(ProjectRole.OWNER))//
				.map(relation -> relation.getUser().getId())
				.toList();
		
		if (!owners.contains(userId)) {
			throw new AccessDeniedException("User does not have permission to modify this project.");
		}
	}

	private void deleteEntireProject(Long projectId) {
		projectDao.deleteById(projectId);
	}

	private void removeVersionFromProject(ProjectTable project, ProjectVersionTable version) {
		// Remove through the managed collection (orphanRemoval deletes the version and cascades
		// to its content). A plain em.remove of a version that is still contained in the
		// project's versions would be cancelled at flush by the PERSIST cascade from the project.
		project.getVersions().remove(version);
		project.setModifiedAt(LocalDateTime.now());
		projectDao.merge(project);
	}

	private Set<ProjectVersion> map(Set<ProjectVersionTable> versions) {
		return versions.stream().map(this::map).collect(Collectors.toSet());
	}

	private ProjectVersion map(ProjectVersionTable table) {
		ProjectVersion projectVersion = new ProjectVersion();
		projectVersion.setId(table.getId());
		projectVersion.setName(table.getName());
		projectVersion.setCreatedAt(table.getCreatedAt());
		projectVersion.setModifiedAt(table.getModifiedAt());
		return projectVersion;
	}

	private Project map(ProjectTable table) {
		Project project = new Project();
		project.setId(table.getId());
		project.setName(table.getName());
		project.setCreatedAt(table.getCreatedAt());
		project.setModifiedAt(table.getModifiedAt());

		project.getVersions().addAll(map(table.getVersions()));
		project.getProjectMembers().addAll(mapUsers(table.getUserRelations()));

		return project;
	}

	private Set<ProjectMember> mapUsers(Set<ProjectUserRelationTable> userRelations) {
		
		return userRelations//
				.stream()//
				.map(this::map)//
				.collect(Collectors.toSet());
	}
	
	private ProjectMember map(ProjectUserRelationTable relationTable) {
		ProjectMember member = new ProjectMember();
		member.setFirstName(relationTable.getUser().getFirstName());
		member.setLastName(relationTable.getUser().getLastName());
		member.setRole(relationTable.getRole());
		return member;
	}

	private ProjectInvitation map(ProjectInvitationTable table) {
		ProjectInvitation invitation = new ProjectInvitation();
		invitation.setId(table.getId());
		invitation.setEmail(table.getEmail());
		invitation.setRole(table.getRole());
		invitation.setInvitedBy(table.getInvitedBy());
		invitation.setCreatedAt(table.getCreatedAt());
		return invitation;
	}
}