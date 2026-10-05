package de.envite.proa.repository;

import de.envite.proa.repository.tables.UserTable;
import de.envite.proa.repository.user.UserDao;
import io.quarkus.test.junit.QuarkusTest;
import jakarta.inject.Inject;
import jakarta.persistence.EntityManager;
import jakarta.transaction.Transactional;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;

@QuarkusTest
public class UserDaoTest {

	private static final String EMAIL_1 = "test1@example.com";
	private static final String EMAIL_2 = "test2@example.com";
	private static final String SUBJECT_1 = "subject-1";
	private static final String SUBJECT_2 = "subject-2";

	@Inject
	UserDao userDao;

	@Inject
	EntityManager em;

	@BeforeEach
	@Transactional
	void cleanupDatabase() {
		em.createQuery("DELETE FROM UserTable").executeUpdate();
	}

	@Test
	@Transactional
	void testFindByEmail() {
		UserTable user = new UserTable();
		user.setEmail(EMAIL_1);
		em.persist(user);

		UserTable foundUser = userDao.findByEmail(EMAIL_1);

		assertNotNull(foundUser);
		assertEquals(EMAIL_1, foundUser.getEmail());
	}

	@Test
	@Transactional
	void testFindByEmailNotFound() {
		UserTable foundUser = userDao.findByEmail(EMAIL_1);
		assertNull(foundUser);
	}

	/**
	 * E-mail is no longer unique (the identity key is the OIDC subject): after e-mail
	 * recycling two rows can carry the same address and the newest row is the live identity.
	 */
	@Test
	@Transactional
	void testFindByEmail_DuplicateEmails_ReturnsNewestRow() {
		UserTable stale = new UserTable();
		stale.setEmail(EMAIL_1);
		stale.setOidcSubject(SUBJECT_1);
		em.persist(stale);

		UserTable current = new UserTable();
		current.setEmail(EMAIL_1);
		current.setOidcSubject(SUBJECT_2);
		em.persist(current);
		em.flush();

		UserTable foundUser = userDao.findByEmail(EMAIL_1);

		assertNotNull(foundUser);
		assertEquals(current.getId(), foundUser.getId());
	}

	@Test
	@Transactional
	void testFindBySubject() {
		UserTable user = new UserTable();
		user.setEmail(EMAIL_1);
		user.setOidcSubject(SUBJECT_1);
		em.persist(user);

		UserTable foundUser = userDao.findBySubject(SUBJECT_1);

		assertNotNull(foundUser);
		assertEquals(user.getId(), foundUser.getId());
	}

	@Test
	@Transactional
	void testFindBySubjectNotFound() {
		assertNull(userDao.findBySubject(SUBJECT_1));
	}

	/** Only rows that predate the subject binding (oidcSubject null) are legacy-claimable. */
	@Test
	@Transactional
	void testFindLegacyByEmail() {
		UserTable legacy = new UserTable();
		legacy.setEmail(EMAIL_1);
		em.persist(legacy);

		UserTable bound = new UserTable();
		bound.setEmail(EMAIL_2);
		bound.setOidcSubject(SUBJECT_2);
		em.persist(bound);
		em.flush();

		UserTable foundLegacy = userDao.findLegacyByEmail(EMAIL_1);
		assertNotNull(foundLegacy);
		assertEquals(legacy.getId(), foundLegacy.getId());

		assertNull(userDao.findLegacyByEmail(EMAIL_2));
	}

	/**
	 * The guarded UPDATE backfills the subject exactly once: a second claim (e.g. a different
	 * principal racing for the same legacy row) must lose and not overwrite the binding.
	 */
	@Test
	@Transactional
	void testClaimSubject_ExactlyOnce() {
		UserTable legacy = new UserTable();
		legacy.setEmail(EMAIL_1);
		em.persist(legacy);
		em.flush();

		assertTrue(userDao.claimSubject(legacy.getId(), SUBJECT_1));
		assertFalse(userDao.claimSubject(legacy.getId(), SUBJECT_2));

		em.clear();
		UserTable claimed = em.find(UserTable.class, legacy.getId());
		assertEquals(SUBJECT_1, claimed.getOidcSubject());
	}

	@Test
	@Transactional
	void testFindById() {
		UserTable user = new UserTable();
		user.setEmail(EMAIL_1);
		em.persist(user);

		UserTable foundUser = userDao.findById(user.getId());
		assertNotNull(foundUser);
		assertEquals(user.getId(), foundUser.getId());
	}

	@Test
	@Transactional
	void testSave() {
		UserTable user = new UserTable();
		user.setEmail(EMAIL_1);

		UserTable savedUser = userDao.save(user);

		assertNotNull(savedUser.getId());

		flushAndClear();

		UserTable dbUser = em.find(UserTable.class, savedUser.getId());
		assertNotNull(dbUser);
		assertEquals(EMAIL_1, dbUser.getEmail());
	}

	@Test
	@Transactional
	void testPatchUser() {
		UserTable user = new UserTable();
		user.setEmail(EMAIL_1);
		em.persist(user);

		user.setEmail(EMAIL_2);

		UserTable updatedUser = userDao.patchUser(user);

		flushAndClear();

		assertNotNull(updatedUser);
		assertEquals(EMAIL_2, updatedUser.getEmail());

		UserTable dbUser = em.find(UserTable.class, user.getId());
		assertEquals(EMAIL_2, dbUser.getEmail());
	}

	private void flushAndClear() {
		em.flush();
		em.clear();
	}
}
