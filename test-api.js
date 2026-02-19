const API_URL = 'http://localhost:5000/api';

async function testBackend() {
  try {
    console.log('--- Testing Registration ---');
    const uniqueEmail = `test${Date.now()}@example.com`;

    // Register
    const registerResponse = await fetch(`${API_URL}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Test User',
        email: uniqueEmail,
        password: 'password123',
        role: 'seeker'
      })
    });

    const registerData = await registerResponse.json();
    console.log('Registration Status:', registerResponse.status);
    console.log('Registration Success:', registerData.success);

    if (!registerData.success) {
      console.error('Registration failed:', registerData);
      return;
    }

    const token = registerData.token;

    console.log('\n--- Testing Login ---');
    const loginResponse = await fetch(`${API_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: uniqueEmail,
        password: 'password123'
      })
    });

    const loginData = await loginResponse.json();
    console.log('Login Status:', loginResponse.status);
    console.log('Login Success:', loginData.success);

    if (!loginData.success) {
      console.error('Login failed:', loginData);
      return;
    }

    console.log('\n--- Testing Create Request ---');
    const requestResponse = await fetch(`${API_URL}/requests/search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        category: 'Plumbing',
        budget: 50,
        estimatedArrivalTime: 30,
        longitude: -74.006,
        latitude: 40.7128
      })
    });

    const requestData = await requestResponse.json();
    console.log('Request Creation Status:', requestResponse.status);
    console.log('Request Creation Success:', requestData.success);

    if (requestData.success) {
      console.log('Request Data:', requestData.data);
    } else {
      console.error('Request creation failed:', requestData);
    }

  } catch (err) {
    console.error('Unexpected error:', err);
  }
}

testBackend();
