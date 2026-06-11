package de.envite.proa.repository;

import de.envite.proa.entities.authentication.User;
import de.envite.proa.repository.tables.UserTable;
import de.envite.proa.repository.user.UserDao;
import de.envite.proa.repository.user.UserRepositoryImpl;
import jakarta.ws.rs.NotFoundException;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.MockitoAnnotations;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

class UserRepositoryImplTest {

	private static final Long USER_ID = 1L;

	@InjectMocks
	private UserRepositoryImpl userRepository;

	@Mock
	private UserDao userDao;

	@BeforeEach
	void setUp() {
		MockitoAnnotations.openMocks(this);
	}

	@Test
	void testFindById_UserExists() {
		UserTable userTable = new UserTable();
		userTable.setId(USER_ID);
		when(userDao.findById(USER_ID)).thenReturn(userTable);

		User user = userRepository.findById(USER_ID);

		assertNotNull(user);
		assertEquals(USER_ID, user.getId());
		verify(userDao).findById(USER_ID);
	}

	@Test
	void testFindById_UserDoesNotExist() {
		when(userDao.findById(USER_ID)).thenReturn(null);

		assertThrows(NotFoundException.class, () -> userRepository.findById(USER_ID));
		verify(userDao).findById(USER_ID);
	}
}
