package de.envite.proa.repository;

import de.envite.proa.entities.authentication.Role;
import de.envite.proa.entities.authentication.User;
import de.envite.proa.repository.tables.UserTable;
import de.envite.proa.repository.user.UserMapper;
import org.junit.jupiter.api.Test;

import java.time.LocalDateTime;

import static org.junit.jupiter.api.Assertions.*;

class UserMapperTest {

	private static final Long USER_ID = 1L;
	private static final String EMAIL = "test@example.com";
	private static final String FIRST_NAME = "John";
	private static final String LAST_NAME = "Doe";
	private static final String ROLE_ADMIN = "Admin";
	private static final String ROLE_USER = "User";
	private static final Role ROLE_ADMIN_ENUM = Role.Admin;
	private static final Role ROLE_USER_ENUM = Role.User;
	private static final LocalDateTime CREATED_AT = LocalDateTime.now();
	private static final LocalDateTime MODIFIED_AT = LocalDateTime.now();

	@Test
	void testClassInitialization() {
		UserMapper mapper = new UserMapper();
		assertNotNull(mapper);
	}

	@Test
	void testMapUserTableToUser_AdminRole() {
		UserTable table = new UserTable();
		table.setId(USER_ID);
		table.setEmail(EMAIL);
		table.setFirstName(FIRST_NAME);
		table.setLastName(LAST_NAME);
		table.setCreatedAt(CREATED_AT);
		table.setModifiedAt(MODIFIED_AT);
		table.setRole(ROLE_ADMIN_ENUM);

		User user = UserMapper.map(table);

		assertNotNull(user);
		assertEquals(USER_ID, user.getId());
		assertEquals(EMAIL, user.getEmail());
		assertEquals(FIRST_NAME, user.getFirstName());
		assertEquals(LAST_NAME, user.getLastName());
		assertEquals(CREATED_AT, user.getCreatedAt());
		assertEquals(MODIFIED_AT, user.getModifiedAt());
		assertEquals(ROLE_ADMIN, user.getRole());
	}

	@Test
	void testMapUserTableToUser_UserRole() {
		UserTable table = new UserTable();
		table.setId(USER_ID);
		table.setEmail(EMAIL);
		table.setFirstName(FIRST_NAME);
		table.setLastName(LAST_NAME);
		table.setCreatedAt(CREATED_AT);
		table.setModifiedAt(MODIFIED_AT);
		table.setRole(ROLE_USER_ENUM);

		User user = UserMapper.map(table);

		assertNotNull(user);
		assertEquals(USER_ID, user.getId());
		assertEquals(EMAIL, user.getEmail());
		assertEquals(FIRST_NAME, user.getFirstName());
		assertEquals(LAST_NAME, user.getLastName());
		assertEquals(CREATED_AT, user.getCreatedAt());
		assertEquals(MODIFIED_AT, user.getModifiedAt());
		assertEquals(ROLE_USER, user.getRole());
	}
}
