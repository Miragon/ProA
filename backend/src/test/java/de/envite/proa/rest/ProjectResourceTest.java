package de.envite.proa.rest;

import de.envite.proa.entities.project.AccessDeniedException;
import de.envite.proa.entities.project.AddContributorResult;
import de.envite.proa.entities.project.NoResultException;
import de.envite.proa.entities.project.Project;
import de.envite.proa.entities.project.ProjectInvitation;
import de.envite.proa.security.CurrentUserService;
import de.envite.proa.usecases.project.ProjectUsecase;
import jakarta.ws.rs.core.Response;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.MockitoAnnotations;

import java.util.Arrays;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.Mockito.*;

public class ProjectResourceTest {

	@InjectMocks
	private ProjectResource resource;

	@Mock
	private ProjectUsecase usecase;

	@Mock
	private CurrentUserService currentUserService;

	private static final Long USER_ID = 1L;
	private static final Long PROJECT_ID_1 = 1L;
	private static final Long PROJECT_VERSIOM_ID_1 = 3L;
	private static final String PROJECT_NAME_1 = "Test Project 1";
	private static final String PROJECT_VERSION_1 = "1.0";
	private static final Long PROJECT_ID_2 = 2L;
	private static final String PROJECT_NAME_2 = "Test Project 2";
	private static final String PROJECT_VERSION_2 = "3.0";
	private static final String APP_MODE_WEB = "web";
	private static final String APP_MODE_DESKTOP = "desktop";

	private static Project expectedProject1;
	private static Project expectedProject2;

	@BeforeAll
	public static void setUpClass() {
		expectedProject1 = new Project();
		expectedProject1.setId(PROJECT_ID_1);
		expectedProject1.setName(PROJECT_NAME_1);

		expectedProject2 = new Project();
		expectedProject2.setId(PROJECT_ID_2);
		expectedProject2.setName(PROJECT_NAME_2);
	}

	@BeforeEach
	public void setUp() {
		MockitoAnnotations.openMocks(this);
	}

	@Test
	public void testCreateProjectWebMode() {
		when(currentUserService.getUserId()).thenReturn(USER_ID);
		resource.appMode = APP_MODE_WEB;

		when(usecase.createProject(USER_ID, PROJECT_NAME_1, PROJECT_VERSION_1)).thenReturn(expectedProject1);

		Response response = resource.createProject(PROJECT_NAME_1, PROJECT_VERSION_1);
		Project result = response.readEntity(Project.class);

		assertEquals(201, response.getStatus());
		assertEquals(expectedProject1, result);
		verify(currentUserService, times(1)).getUserId();
		verify(usecase, times(1)).createProject(USER_ID, PROJECT_NAME_1, PROJECT_VERSION_1);
	}

	@Test
	public void testCreateProjectDesktopMode() {
		resource.appMode = APP_MODE_DESKTOP;

		when(usecase.createProject(PROJECT_NAME_1, PROJECT_VERSION_1)).thenReturn(expectedProject1);

		Response response = resource.createProject(PROJECT_NAME_1, PROJECT_VERSION_1);
		Project result = response.readEntity(Project.class);

		assertEquals(201, response.getStatus());
		assertEquals(expectedProject1, result);
		verify(currentUserService, never()).getUserId();
		verify(usecase, times(1)).createProject(PROJECT_NAME_1, PROJECT_VERSION_1);
	}

	@Test
	public void testGetProjectsWebMode() {
		when(currentUserService.getUserId()).thenReturn(USER_ID);
		resource.appMode = APP_MODE_WEB;

		List<Project> expectedProjects = Arrays.asList(
				expectedProject1, expectedProject2
		);

		when(usecase.getProjects(USER_ID)).thenReturn(expectedProjects);

		List<Project> result = resource.getProjects();

		assertEquals(expectedProjects, result);
		verify(currentUserService, times(1)).getUserId();
		verify(usecase, times(1)).getProjects(USER_ID);
	}

	@Test
	public void testGetProjectsDesktopMode() {
		resource.appMode = APP_MODE_DESKTOP;

		List<Project> expectedProjects = Arrays.asList(
				expectedProject1, expectedProject2
		);

		when(usecase.getProjects()).thenReturn(expectedProjects);

		List<Project> result = resource.getProjects();

		assertEquals(expectedProjects, result);
		verify(currentUserService, never()).getUserId();
		verify(usecase, times(1)).getProjects();
	}

	@Test
	public void testGetProjectWebMode() {
		when(currentUserService.getUserId()).thenReturn(USER_ID);
		resource.appMode = APP_MODE_WEB;

		when(usecase.getProject(USER_ID, PROJECT_ID_1)).thenReturn(expectedProject1);

		Response result = resource.getProject(PROJECT_ID_1);

		assertEquals(Response.Status.OK.getStatusCode(), result.getStatus());
		assertEquals(expectedProject1, result.getEntity());
		verify(currentUserService, times(1)).getUserId();
		verify(usecase, times(1)).getProject(USER_ID, PROJECT_ID_1);
	}

	/**
	 * Error statuses are produced by the exception mappers in de.envite.proa.rest.mappers,
	 * so the resource lets the exceptions propagate (NoResultException -> 404,
	 * AccessDeniedException -> 403, generic -> 500).
	 */
	@Test
	public void testGetProjectWebMode_NotFound() {
		when(currentUserService.getUserId()).thenReturn(USER_ID);
		resource.appMode = APP_MODE_WEB;

		when(usecase.getProject(USER_ID, PROJECT_ID_1)).thenThrow(new NoResultException());

		assertThrows(NoResultException.class, () -> resource.getProject(PROJECT_ID_1));

		verify(currentUserService, times(1)).getUserId();
		verify(usecase, times(1)).getProject(USER_ID, PROJECT_ID_1);
	}

	@Test
	public void testGetProjectWebMode_Forbidden() {
		when(currentUserService.getUserId()).thenReturn(USER_ID);
		resource.appMode = APP_MODE_WEB;

		when(usecase.getProject(USER_ID, PROJECT_ID_1)).thenThrow(new AccessDeniedException());

		assertThrows(AccessDeniedException.class, () -> resource.getProject(PROJECT_ID_1));

		verify(currentUserService, times(1)).getUserId();
		verify(usecase, times(1)).getProject(USER_ID, PROJECT_ID_1);
	}

	@Test
	public void testGetProjectWebMode_InternalServerError() {
		when(currentUserService.getUserId()).thenReturn(USER_ID);
		resource.appMode = APP_MODE_WEB;

		when(usecase.getProject(USER_ID, PROJECT_ID_1)).thenThrow(new RuntimeException());

		assertThrows(RuntimeException.class, () -> resource.getProject(PROJECT_ID_1));

		verify(currentUserService, times(1)).getUserId();
		verify(usecase, times(1)).getProject(USER_ID, PROJECT_ID_1);
	}

	@Test
	public void testGetProjectDesktopMode() {
		resource.appMode = APP_MODE_DESKTOP;

		when(usecase.getProject(PROJECT_ID_1)).thenReturn(expectedProject1);

		Response result = resource.getProject(PROJECT_ID_1);

		assertEquals(Response.Status.OK.getStatusCode(), result.getStatus());
		assertEquals(expectedProject1, result.getEntity());
		verify(currentUserService, never()).getUserId();
		verify(usecase, times(1)).getProject(PROJECT_ID_1);
	}

	@Test
	public void testGetProjectDesktopMode_NotFound() {
		resource.appMode = APP_MODE_DESKTOP;

		when(usecase.getProject(PROJECT_ID_1)).thenThrow(new NoResultException());

		assertThrows(NoResultException.class, () -> resource.getProject(PROJECT_ID_1));

		verify(currentUserService, never()).getUserId();
		verify(usecase, times(1)).getProject(PROJECT_ID_1);
	}

	@Test
	public void testGetProjectDesktopMode_InternalServerError() {
		resource.appMode = APP_MODE_DESKTOP;

		when(usecase.getProject(PROJECT_ID_1)).thenThrow(new RuntimeException());

		assertThrows(RuntimeException.class, () -> resource.getProject(PROJECT_ID_1));

		verify(currentUserService, never()).getUserId();
		verify(usecase, times(1)).getProject(PROJECT_ID_1);
	}

	@Test
	public void testDeleteProject_DesktopMode() throws NoResultException {
		resource.appMode = APP_MODE_DESKTOP;
		doNothing().when(usecase).removeVersion(PROJECT_ID_1, PROJECT_VERSIOM_ID_1);

		resource.removeVersion(PROJECT_ID_1, PROJECT_VERSIOM_ID_1);

		verify(currentUserService, never()).getUserId();
		verify(usecase, times(1)).removeVersion(PROJECT_ID_1, PROJECT_VERSIOM_ID_1);
	}

	@Test
	public void testDeleteProject_WebMode() throws AccessDeniedException, NoResultException {
		resource.appMode = APP_MODE_WEB;
		doNothing().when(usecase).removeVersion(USER_ID, PROJECT_ID_1, PROJECT_VERSIOM_ID_1);
		when(currentUserService.getUserId()).thenReturn(USER_ID);

		resource.removeVersion(PROJECT_ID_1, PROJECT_VERSIOM_ID_1);

		verify(currentUserService, times(1)).getUserId();
		verify(usecase, times(1)).removeVersion(USER_ID, PROJECT_ID_1, PROJECT_VERSIOM_ID_1);
	}

	@Test
	public void testAddContributor_ReturnsUsecaseResult() {
		String email = "invitee@example.com";
		AddContributorResult expectedResult = AddContributorResult.memberAdded();
		when(currentUserService.getUserId()).thenReturn(USER_ID);
		when(usecase.addContributor(USER_ID, PROJECT_ID_1, email)).thenReturn(expectedResult);

		Response response = resource.addContributor(PROJECT_ID_1, email);

		assertEquals(Response.Status.OK.getStatusCode(), response.getStatus());
		assertEquals(expectedResult, response.getEntity());
		verify(usecase, times(1)).addContributor(USER_ID, PROJECT_ID_1, email);
	}

	@Test
	public void testAddContributor_BlankEmail_BadRequest() {
		Response response = resource.addContributor(PROJECT_ID_1, "   ");

		assertEquals(Response.Status.BAD_REQUEST.getStatusCode(), response.getStatus());
		verify(usecase, never()).addContributor(anyLong(), anyLong(), anyString());
		verify(currentUserService, never()).getUserId();
	}

	@Test
	public void testGetInvitations() {
		List<ProjectInvitation> expectedInvitations = List.of(new ProjectInvitation());
		when(currentUserService.getUserId()).thenReturn(USER_ID);
		when(usecase.getInvitations(USER_ID, PROJECT_ID_1)).thenReturn(expectedInvitations);

		List<ProjectInvitation> invitations = resource.getInvitations(PROJECT_ID_1);

		assertEquals(expectedInvitations, invitations);
		verify(usecase, times(1)).getInvitations(USER_ID, PROJECT_ID_1);
	}

	@Test
	public void testRevokeInvitation() {
		long invitationId = 7L;
		when(currentUserService.getUserId()).thenReturn(USER_ID);
		doNothing().when(usecase).revokeInvitation(USER_ID, PROJECT_ID_1, invitationId);

		Response response = resource.revokeInvitation(PROJECT_ID_1, invitationId);

		assertEquals(Response.Status.NO_CONTENT.getStatusCode(), response.getStatus());
		verify(usecase, times(1)).revokeInvitation(USER_ID, PROJECT_ID_1, invitationId);
	}
}
