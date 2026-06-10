package de.envite.proa.rest;

import java.util.List;
import java.util.Map;

import org.eclipse.microprofile.config.inject.ConfigProperty;
import org.eclipse.microprofile.jwt.JsonWebToken;
import org.jboss.resteasy.reactive.RestForm;
import org.jboss.resteasy.reactive.RestPath;

import de.envite.proa.entities.project.Project;
import de.envite.proa.entities.project.ProjectVersion;
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

	private static final String USER_ID = "userId";

	@Inject
	private ProjectUsecase usecase;

	@Inject
	JsonWebToken jwt;

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
			Long userId = Long.parseLong(jwt.getClaim(USER_ID).toString());
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
			Long userId = Long.parseLong(jwt.getClaim(USER_ID).toString());
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
			Long userId = Long.parseLong(jwt.getClaim(USER_ID).toString());
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
			Long userId = Long.parseLong(jwt.getClaim(USER_ID).toString());
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
			Long userId = Long.parseLong(jwt.getClaim(USER_ID).toString());
			usecase.removeVersion(userId, projectId, versionId);
		} else {
			usecase.removeVersion(projectId, versionId);
		}
		return Response.ok().entity(Map.of("message", "Version removed")).build();
	}

	@POST
	@Path("/project/{projectId}/contributor")
	@RolesAllowed({ "User", "Admin" })
	public Response addContributor(@RestPath Long projectId, @RestForm String email) {
		Long userId = Long.parseLong(jwt.getClaim(USER_ID).toString());
		usecase.addContributor(userId, projectId, email);
		return Response.ok().entity(Map.of("message", "Contributor added successfully")).build();
	}

	@DELETE
	@Path("/project/{projectId}/contributor/{contributorId}")
	@RolesAllowed({ "User", "Admin" })
	public Response removeContributor(@RestPath Long projectId, @RestPath Long contributorId) {
		Long userId = Long.parseLong(jwt.getClaim(USER_ID).toString());
		usecase.removeContributor(userId, projectId, contributorId);
		return Response.noContent().build();
	}
}
