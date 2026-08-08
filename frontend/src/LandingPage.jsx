import React, { useState, useContext } from 'react';
import { Card, Container, Row, Col, Button, Form } from 'react-bootstrap';
import { AuthContext } from './AuthContext';
import { useLogin, useSignup, useForgotPassword } from './datamodel/useAuthQueries';
import { setAuthToken } from './datamodel/api';

export default function LandingPage() {
  return (
    <Container className="d-flex align-items-center justify-content-center min-vh-100">
      <div className="w-100">
        <div className="text-center mb-5">
          <img
            src="/Nagelfluh.jpg"
            alt="Nagelfluh"
            style={{ maxWidth: '300px', width: '100%', height: 'auto' }}
            className="mb-3"
          />
          <h1>Nagelfluh Geophysics</h1>
        </div>
        <Row className="g-4">
          <Col md={4}>
            <SignInCard />
          </Col>
          <Col md={4}>
            <PricingCard />
          </Col>
          <Col md={4}>
            <OpenSourceCard />
          </Col>
        </Row>
      </div>
    </Container>
  );
}

function SignInCard({ initialMode = 'signin', allowBackToSignIn = true }) {
  const [mode, setMode] = useState(initialMode);  // 'signin' | 'signup' | 'forgot'
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [email, setEmail] = useState('');
  const { login: authLogin } = useContext(AuthContext);
  const loginMutation = useLogin();
  const signupMutation = useSignup();
  const forgotPasswordMutation = useForgotPassword();

  const handleSignIn = async (e) => {
    e.preventDefault();
    try {
      console.log('Attempting login with:', username);
      const result = await loginMutation.mutateAsync({ username, password });
      console.log('Login result:', result);
      setAuthToken(result.access_token);
      authLogin(result.user, result.access_token);
      console.log('Login successful, user:', result.user);
    } catch (error) {
      console.error('Login error:', error);
      alert('Login failed: ' + (error.response?.data?.detail || error.message));
    }
  };

  const handleSignUp = async (e) => {
    e.preventDefault();
    try {
      const result = await signupMutation.mutateAsync({ username, password, email: email || undefined });
      setAuthToken(result.access_token);
      authLogin(result.user, result.access_token);
    } catch (error) {
      alert('Signup failed: ' + (error.response?.data?.detail || error.message));
    }
  };

  const handleForgotPassword = async (e) => {
    e.preventDefault();
    try {
      await forgotPasswordMutation.mutateAsync({ email });
      alert('Password reset instructions sent!');
      setMode('signin');
    } catch (error) {
      alert('Failed to send reset email');
    }
  };

  return (
    <Card>
      <div className="card-header py-3">
        <h4 className="my-0 fw-normal">
          {mode === 'signin' ? 'Sign In' : mode === 'signup' ? 'Sign Up' : 'Forgot Password'}
        </h4>
      </div>
      <Card.Body>
        {mode === 'signin' && (
          <Form onSubmit={handleSignIn}>
            <Form.Group className="mb-3">
              <Form.Control
                type="text"
                placeholder="Username"
                value={username}
                onChange={e => setUsername(e.target.value)}
                required
              />
            </Form.Group>
            <Form.Group className="mb-3">
              <Form.Control
                type="password"
                placeholder="Password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                required
              />
            </Form.Group>
            <Button type="submit" variant="primary" className="w-100">
              Sign In
            </Button>
            <div className="mt-2 text-center">
              <a href="#" onClick={(e) => { e.preventDefault(); setMode('forgot'); }}>
                Forgot password?
              </a>
            </div>
            <div className="mt-2 text-center">
              <a href="#" onClick={(e) => { e.preventDefault(); setMode('signup'); }}>
                Don't have an account? Sign up
              </a>
            </div>
          </Form>
        )}
        {mode === 'signup' && (
          <Form onSubmit={handleSignUp}>
            <Form.Group className="mb-3">
              <Form.Control
                type="text"
                placeholder="Username"
                value={username}
                onChange={e => setUsername(e.target.value)}
                required
              />
            </Form.Group>
            <Form.Group className="mb-3">
              <Form.Control
                type="email"
                placeholder="Email (optional)"
                value={email}
                onChange={e => setEmail(e.target.value)}
              />
            </Form.Group>
            <Form.Group className="mb-3">
              <Form.Control
                type="password"
                placeholder="Password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                required
              />
            </Form.Group>
            <Button type="submit" variant="primary" className="w-100">
              Sign Up
            </Button>
            {allowBackToSignIn && (
              <div className="mt-2 text-center">
                <a href="#" onClick={(e) => { e.preventDefault(); setMode('signin'); }}>
                  Back to sign in
                </a>
              </div>
            )}
          </Form>
        )}
        {mode === 'forgot' && (
          <Form onSubmit={handleForgotPassword}>
            <Form.Group className="mb-3">
              <Form.Control
                type="email"
                placeholder="Email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                required
              />
            </Form.Group>
            <Button type="submit" variant="primary" className="w-100">
              Reset Password
            </Button>
            <div className="mt-2 text-center">
              <a href="#" onClick={(e) => { e.preventDefault(); setMode('signin'); }}>
                Back to sign in
              </a>
            </div>
          </Form>
        )}
      </Card.Body>
    </Card>
  );
}

function PricingCard() {
  const [showSignup, setShowSignup] = useState(false);

  if (showSignup) {
    return <SignInCard initialMode="signup" allowBackToSignIn={false} />;
  }

  return (
    <Card>
      <div className="card-header py-3">
        <h4 className="my-0 fw-normal">Hosted version</h4>
      </div>
      <Card.Body>
        <h3 className="text-center my-4">$0.01/compute minute</h3>
        <ul>
          <li>No system administration, no hardware</li>
          <li>Pay only for what you use</li>
          <li>100 credits included</li>
          <li>Unlimited projects</li>
          <li>Unlimited storage</li>
          <li>Same open source code</li>
        </ul>
        <Button variant="success" className="w-100" onClick={() => setShowSignup(true)}>
          Sign Up Now
        </Button>
      </Card.Body>
    </Card>
  );
}

function OpenSourceCard() {
  return (
    <Card>
      <div className="card-header py-3">
        <h4 className="my-0 fw-normal">Open Source</h4>
      </div>
      <Card.Body>
        <p>Nagelfluh is open source and available on GitHub.</p>
        <Button
          variant="outline-primary"
          className="w-100 mb-2"
          onClick={() => window.open('https://github.com/YmerFlow/Ymerflow', '_blank')}
        >
          View on GitHub
        </Button>
        <hr />
        <h6>Deploy on Kubernetes</h6>
        <p className="small">Self-host Nagelfluh on your own infrastructure.</p>
        <Button
          variant="outline-secondary"
          className="w-100"
          onClick={() => window.open('https://ymerflow.org/docs/deployment.html', '_blank')}
        >
          Deployment Guide
        </Button>
      </Card.Body>
    </Card>
  );
}
