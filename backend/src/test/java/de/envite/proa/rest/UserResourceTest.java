package de.envite.proa.rest;

import de.envite.proa.entities.authentication.User;
import de.envite.proa.repository.tables.UserTable;
import de.envite.proa.security.CurrentUserService;
import de.envite.proa.usecases.user.UserUsecase;
import jakarta.persistence.NoResultException;
import jakarta.ws.rs.core.Response;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.MockitoAnnotations;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.mockito.Mockito.*;

public class UserResourceTest {

	@InjectMocks
	private UserResource resource;

	@Mock
	private UserUsecase usecase;

	@Mock
	private CurrentUserService currentUserService;

	private static final Long USER_ID = 1L;
	private static final String USER_EMAIL = "user@example.com";
	private static final String OTHER_EMAIL = "other@example.com";
	private static final User USER = new User();
	private static final User PATCHED_USER = new User();

	private UserTable currentUser;

	@BeforeEach
	public void setUp() {
		MockitoAnnotations.openMocks(this);

		currentUser = new UserTable();
		currentUser.setId(USER_ID);
		currentUser.setEmail(USER_EMAIL);
	}

	@Test
	public void testPatchUserAdminRole() {
		when(usecase.patchUser(USER_ID, USER)).thenReturn(PATCHED_USER);

		Response response = resource.patchUser(USER_ID, USER);

		assertEquals(Response.Status.OK.getStatusCode(), response.getStatus());
		assertEquals(PATCHED_USER, response.getEntity());
		verify(usecase, times(1)).patchUser(USER_ID, USER);
	}

	@Test
	public void testPatchUserUserRole() {
		when(currentUserService.getUser()).thenReturn(currentUser);
		when(usecase.patchUser(USER_ID, USER)).thenReturn(PATCHED_USER);

		Response response = resource.patchUser(USER);

		assertEquals(Response.Status.OK.getStatusCode(), response.getStatus());
		assertEquals(PATCHED_USER, response.getEntity());
		verify(currentUserService, times(1)).getUser();
		verify(usecase, times(1)).patchUser(USER_ID, USER);
	}

	@Test
	public void testPatchUserUserRole_UnchangedEmailAllowed() {
		when(currentUserService.getUser()).thenReturn(currentUser);

		User user = new User();
		user.setEmail(USER_EMAIL);
		when(usecase.patchUser(USER_ID, user)).thenReturn(PATCHED_USER);

		Response response = resource.patchUser(user);

		assertEquals(Response.Status.OK.getStatusCode(), response.getStatus());
		verify(usecase, times(1)).patchUser(USER_ID, user);
	}

	/**
	 * The e-mail is owned by Keycloak and read-only in the application: attempting to change it
	 * is rejected with a clear 400.
	 */
	@Test
	public void testPatchUserUserRole_EmailChangeRejected() {
		when(currentUserService.getUser()).thenReturn(currentUser);

		User user = new User();
		user.setEmail(OTHER_EMAIL);

		Response response = resource.patchUser(user);

		assertEquals(Response.Status.BAD_REQUEST.getStatusCode(), response.getStatus());
		verify(usecase, never()).patchUser(anyLong(), any(User.class));
	}

	@Test
	public void testGetUserSuccess() {
		when(currentUserService.getUserId()).thenReturn(USER_ID);
		when(usecase.findById(USER_ID)).thenReturn(USER);

		Response response = resource.getUser();

		assertEquals(Response.Status.OK.getStatusCode(), response.getStatus());
		assertEquals(USER, response.getEntity());
		verify(currentUserService, times(1)).getUserId();
		verify(usecase, times(1)).findById(USER_ID);
	}

	@Test
	public void testGetUserNotFound() {
		when(currentUserService.getUserId()).thenReturn(USER_ID);
		when(usecase.findById(USER_ID)).thenThrow(new jakarta.ws.rs.NotFoundException());

		Response response = resource.getUser();

		assertEquals(Response.Status.NOT_FOUND.getStatusCode(), response.getStatus());
		verify(currentUserService, times(1)).getUserId();
		verify(usecase, times(1)).findById(USER_ID);
	}

	@Test
	public void testGetUserServerError() {
		when(currentUserService.getUserId()).thenReturn(USER_ID);
		when(usecase.findById(USER_ID)).thenThrow(new RuntimeException("Internal Error"));

		Response response = resource.getUser();

		assertEquals(Response.Status.INTERNAL_SERVER_ERROR.getStatusCode(), response.getStatus());
		verify(currentUserService, times(1)).getUserId();
		verify(usecase, times(1)).findById(USER_ID);
	}

	@Test
	public void testDeleteById() {
		doNothing().when(usecase).deleteById(USER_ID);

		Response response = resource.deleteById(USER_ID);

		assertEquals(Response.Status.OK.getStatusCode(), response.getStatus());

		verify(usecase, times(1)).deleteById(USER_ID);
	}

	@Test
	public void testDeleteById_NotFound() {
		doThrow(new NoResultException()).when(usecase).deleteById(USER_ID);

		Response response = resource.deleteById(USER_ID);

		assertEquals(Response.Status.NOT_FOUND.getStatusCode(), response.getStatus());

		verify(usecase, times(1)).deleteById(USER_ID);
	}

	@Test
	public void testDeleteById_InternalServerError() {
		doThrow(new RuntimeException()).when(usecase).deleteById(USER_ID);

		Response response = resource.deleteById(USER_ID);

		assertEquals(Response.Status.INTERNAL_SERVER_ERROR.getStatusCode(), response.getStatus());

		verify(usecase, times(1)).deleteById(USER_ID);
	}

	@Test
	public void testGetUsers() {
		when(usecase.getAllUsers()).thenReturn(List.of(USER));

		Response response = resource.getUsers();

		assertEquals(Response.Status.OK.getStatusCode(), response.getStatus());
		assertEquals(List.of(USER), response.getEntity());

		verify(usecase, times(1)).getAllUsers();
	}

	@Test
	public void testGetUsers_InternalServerError() {
		doThrow(new RuntimeException()).when(usecase).getAllUsers();

		Response response = resource.getUsers();

		assertEquals(Response.Status.INTERNAL_SERVER_ERROR.getStatusCode(), response.getStatus());

		verify(usecase, times(1)).getAllUsers();
	}
}
