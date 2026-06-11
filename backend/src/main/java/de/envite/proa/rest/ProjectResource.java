package de.envite.proa.rest;

import java.util.List;
import java.util.Map;

import org.eclipse.microprofile.config.inject.ConfigProperty;
import org.jboss.resteasy.reactive.RestForm;
import org.jboss.resteasy.reactive.RestPath;

import de.envite.proa.entities.project.AddContributorResult;
import de.envite.proa.entities.project.Project;
import de.envite.proa.entities.project.ProjectInvitation;
import de.envite.proa.entities.project.ProjectVersion;
import de.envite.proa.security.CurrentUserService;
import de.envite.proa.security.RolesAllowedIfWebVersion;
import de.envite.proa.usecases.project.ProjectUsecase;
import jakarta.annotation.security.RolesAllowed;
import jakarta.inject.Inject;
import jakarta.ws.rs.DELETE;
import jakarta.ws.rs.GET;
import jakarta.ws.rs.POST;
import jakarta.ws.rs.Path;
import jakarta.ws.rs.Produces;
import jakarta.ws.rs.core.MediaType;
import jakarta.ws.rs.core.Response;

@Path("/api")
public class ProjectResource {

	@Inject
	private ProjectUsecase usecase;

	@Inject
	CurrentUserService currentUserService;

	@Inject
	@ConfigProperty(name = "app.mode", defaultValue = "web")
	String appMode;

	/**
	 * Creates a new project
	 *
	 * @param name the name of the project to be created
	 * @return the created project
	 */
	@POST
	@Path("/project")
	@RolesAllowedIfWebVersion({ "User", "Admin" })
	public Response createProject(@RestForm String name, @RestForm String version) {
		if (appMode.equals("web")) {
			Long userId = currentUserService.getUserId();
			Project project = usecase.createProject(userId, name, version);
			return Response//
					.status(Response.Status.CREATED)//
					.entity(project)//
					.build();
		}

		Project project = usecase.createProject(name, version);
		return Response//
				.status(Response.Status.CREATED)//
				.entity(project)//
				.build();
	}

	/**
	 * This method gets the names and the corresponding ids of all projects in order
	 * to show them as tiles in the frontend
	 */
	@GET
	@Path("/project")
	@Produces(MediaType.APPLICATION_JSON)
	@RolesAllowedIfWebVersion({ "User", "Admin" })
	public List<Project> getProjects() {
		if (appMode.equals("web")) {
			Long userId = currentUserService.getUserId();
			return usecase.getProjects(userId);
		}
		return usecase.getProjects();
	}

	@GET
	@Path("/project/{projectId}")
	@Produces(MediaType.APPLICATION_JSON)
	@RolesAllowedIfWebVersion({ "User", "Admin" })
	public Response getProject(@RestPath Long projectId) {
		if (appMode.equals("web")) {
			Long userId = currentUserService.getUserId();
			return Response//
					.ok()//
					.entity(usecase.getProject(userId, projectId))//
					.build();
		}
		return Response.ok().entity(usecase.getProject(projectId)).build();
	}

	@POST
	@Path("/project/{projectId}")
	@RolesAllowedIfWebVersion({ "User", "Admin" })
	public Response addVersion(@RestPath Long projectId, @RestForm String versionName) {
		if (appMode.equals("web")) {
			Long userId = currentUserService.getUserId();
			ProjectVersion projectVersion = usecase.addVersion(userId, projectId, versionName);
			return Response//
					.status(Response.Status.CREATED)//
					.entity(projectVersion)//
					.build();
		}

		ProjectVersion projectVersion = usecase.addVersion(projectId, versionName);
		return Response//
				.status(Response.Status.CREATED)//
				.entity(projectVersion)//
				.build();
	}

	@DELETE
	@Path("/project/{projectId}/{versionId}")
	@RolesAllowedIfWebVersion({ "User", "Admin" })
	public Response removeVersion(@RestPath Long projectId, @RestPath Long versionId) {
		if (appMode.equals("web")) {
			Long userId = currentUserService.getUserId();
			usecase.removeVersion(userId, projectId, versionId);
		} else {
			usecase.removeVersion(projectId, versionId);
		}
		return Response.ok().entity(Map.of("message", "Version removed")).build();
	}

	/**
	 * Invites an e-mail address to the project (owner only). Returns whether the membership was
	 * created immediately (the invitee already has a local user) or a pending invitation was
	 * stored, so the frontend can distinguish the two outcomes (ADR-0003).
	 */
	@POST
	@Path("/project/{projectId}/contributor")
	@RolesAllowed({ "User", "Admin" })
	public Response addContributor(@RestPath Long projectId, @RestForm String email) {
		if (email == null || email.isBlank()) {
			return Response//
					.status(Response.Status.BAD_REQUEST)//
					.entity(Map.of("message", "Email must not be blank"))//
					.build();
		}
		Long userId = currentUserService.getUserId();
		AddContributorResult result = usecase.addContributor(userId, projectId, email);
		return Response.ok().entity(result).build();
	}

	@DELETE
	@Path("/project/{projectId}/contributor/{contributorId}")
	@RolesAllowed({ "User", "Admin" })
	public Response removeContributor(@RestPath Long projectId, @RestPath Long contributorId) {
		Long userId = currentUserService.getUserId();
		usecase.removeContributor(userId, projectId, contributorId);
		return Response.noContent().build();
	}

	/** Lists the pending invitations of a project (owner only, ADR-0003). */
	@GET
	@Path("/project/{projectId}/invitation")
	@Produces(MediaType.APPLICATION_JSON)
	@RolesAllowed({ "User", "Admin" })
	public List<ProjectInvitation> getInvitations(@RestPath Long projectId) {
		Long userId = currentUserService.getUserId();
		return usecase.getInvitations(userId, projectId);
	}

	/** Revokes a pending invitation (owner only, ADR-0003). */
	@DELETE
	@Path("/project/{projectId}/invitation/{invitationId}")
	@RolesAllowed({ "User", "Admin" })
	public Response revokeInvitation(@RestPath Long projectId, @RestPath Long invitationId) {
		Long userId = currentUserService.getUserId();
		usecase.revokeInvitation(userId, projectId, invitationId);
		return Response.noContent().build();
	}
}
