package de.envite.proa.repository.user;

import de.envite.proa.entities.authentication.User;
import de.envite.proa.repository.tables.UserTable;
import de.envite.proa.usecases.user.UserRepository;
import jakarta.enterprise.context.ApplicationScoped;
import jakarta.inject.Inject;
import jakarta.ws.rs.NotFoundException;

@ApplicationScoped
public class UserRepositoryImpl implements UserRepository {

	@Inject
	UserDao userDao;

	@Override
	public User findById(Long id) {
		UserTable userTable = userDao.findById(id);
		if (userTable == null) {
			throw new NotFoundException("User not found");
		}
		return UserMapper.map(userTable);
	}
}
