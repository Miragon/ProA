package de.envite.proa.repository.user;

import de.envite.proa.entities.authentication.Role;
import de.envite.proa.entities.authentication.User;
import de.envite.proa.repository.tables.UserTable;

public class UserMapper {

	public static User map(UserTable table) {
		User user = new User();
		user.setId(table.getId());
		user.setEmail(table.getEmail());
		user.setFirstName(table.getFirstName());
		user.setLastName(table.getLastName());
		user.setCreatedAt(table.getCreatedAt());
		user.setModifiedAt(table.getModifiedAt());

		user.setRole(table.getRole() == Role.Admin ? "Admin" : "User");

		return user;
	}
}
