import React, { useState, useContext } from 'react';
import { Card, Container, Row, Col, Button, Form, Modal } from 'react-bootstrap';
import Markdown from 'markdown-to-jsx';
import { AuthContext } from './AuthContext';
import { useLogin, useSignup, useForgotPassword, usePublicConfig, useTos, useAcceptTos } from './datamodel/useAuthQueries';
import { setAuthToken } from './datamodel/api';

export default function LandingPage() {
  return (
    <Container className="d-flex align-items-center justify-content-center min-vh-100">
      <div className="w-100">
        <div className="d-flex align-items-center flex-wrap mb-5 gap-4">
          <img
            src="/YmerFlow.jpg"
            alt="YmerFlow"
            style={{ maxWidth: '200px', width: '100%', height: 'auto', flexShrink: 0 }}
          />
          <div style={{ flex: '1 1 300px' }}>
            <h1>YmerFlow - Cloud-native geophysics</h1>
            <p>
              Browser-based AEM and magnetic survey processing, inversion, and pipeline
              automation — no Windows install, no per-seat licenses, no black-box algorithms.
            </p>
            <p className="mb-0">
              YmerFlow replaces desktop-bound geophysics tools with a reproducible, versioned
              workflow platform that runs in any browser. Processing pipelines are defined as
              visual DAGs, executed in Kubernetes containers, and stored in per-project cloud
              storage so results are always reproducible. The inversion core is SimPEG (GPL v3)
              — peer-reviewed, auditable, and extensible.
            </p>
          </div>
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
  const [showTosModal, setShowTosModal] = useState(false);
  const [pendingLogin, setPendingLogin] = useState(null);  // { user, access_token, tos_pending }
  const { login: authLogin } = useContext(AuthContext);
  const loginMutation = useLogin();
  const signupMutation = useSignup();
  const forgotPasswordMutation = useForgotPassword();
  const acceptTosMutation = useAcceptTos();
  const { data: tos } = useTos();

  const handleSignIn = async (e) => {
    e.preventDefault();
    try {
      const result = await loginMutation.mutateAsync({ username, password });
      setAuthToken(result.access_token);
      if (result.tos_pending) {
        setPendingLogin({ user: result.user, access_token: result.access_token, tos_pending: result.tos_pending });
      } else {
        authLogin(result.user, result.access_token);
      }
    } catch (error) {
      console.error('Login error:', error);
      alert('Login failed: ' + (error.response?.data?.detail || error.message));
    }
  };

  const handleAgreeLoginTos = async () => {
    try {
      await acceptTosMutation.mutateAsync({ version: pendingLogin.tos_pending.version });
      authLogin(pendingLogin.user, pendingLogin.access_token);
      setPendingLogin(null);
    } catch (error) {
      alert('Failed to record agreement: ' + (error.response?.data?.detail || error.message));
    }
  };

  const handleCancelLoginTos = () => {
    setAuthToken(null);
    setPendingLogin(null);
  };

  const doSignup = async () => {
    try {
      const result = await signupMutation.mutateAsync({ username, password, email: email || undefined, agreedTosVersion: tos?.version });
      setAuthToken(result.access_token);
      authLogin(result.user, result.access_token);
    } catch (error) {
      alert('Signup failed: ' + (error.response?.data?.detail || error.message));
    }
  };

  const handleSignUp = (e) => {
    e.preventDefault();
    if (tos?.body) {
      setShowTosModal(true);
    } else {
      doSignup();
    }
  };

  const handleAgreeTos = () => {
    setShowTosModal(false);
    doSignup();
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
    <Card className="h-100">
      <div className="card-header py-3">
        <h4 className="my-0 fw-normal">
          <i
            className={`fas ${mode === 'signin' ? 'fa-key' : mode === 'signup' ? 'fa-handshake' : 'fa-unlock-keyhole'} me-2`}
            aria-hidden="true"
          ></i>
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

      <Modal show={showTosModal} onHide={() => setShowTosModal(false)} backdrop="static" size="lg">
        <Modal.Header>
          <Modal.Title>Terms of Service</Modal.Title>
        </Modal.Header>
        <Modal.Body style={{ maxHeight: '60vh', overflowY: 'auto' }}>
          <Markdown>{tos?.body || ''}</Markdown>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="secondary" onClick={() => setShowTosModal(false)}>Cancel</Button>
          <Button variant="primary" onClick={handleAgreeTos}>I Agree</Button>
        </Modal.Footer>
      </Modal>

      <Modal show={!!pendingLogin} backdrop="static" keyboard={false} size="lg">
        <Modal.Header>
          <Modal.Title>Terms of Service Updated</Modal.Title>
        </Modal.Header>
        <Modal.Body style={{ maxHeight: '60vh', overflowY: 'auto' }}>
          <p>The Terms of Service have been updated since you last agreed. Please review and agree to continue.</p>
          <Markdown>{pendingLogin?.tos_pending?.body || ''}</Markdown>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="secondary" onClick={handleCancelLoginTos}>Cancel</Button>
          <Button variant="primary" onClick={handleAgreeLoginTos} disabled={acceptTosMutation.isPending}>
            {acceptTosMutation.isPending ? 'Saving...' : 'I Agree'}
          </Button>
        </Modal.Footer>
      </Modal>
    </Card>
  );
}

function PricingCard() {
  const [showSignup, setShowSignup] = useState(false);
  const { data: publicConfig } = usePublicConfig();

  if (showSignup) {
    return <SignInCard initialMode="signup" allowBackToSignIn={false} />;
  }

  return (
    <Card className="h-100">
      <div className="card-header py-3">
        <h4 className="my-0 fw-normal">
          <i className="fas fa-cloud me-2" aria-hidden="true"></i>
          Hosted version
        </h4>
      </div>
      <Card.Body>
        {publicConfig?.hosted_version_text && (
          <Markdown>{publicConfig.hosted_version_text}</Markdown>
        )}
        <Button variant="success" className="w-100" onClick={() => setShowSignup(true)}>
          Sign Up Now
        </Button>
      </Card.Body>
    </Card>
  );
}

const OPEN_SOURCE_LINKS = [
  {
    href: 'https://github.com/YmerFlow/Ymerflow',
    icon: 'fab fa-github',
    text: 'Grab the full source on GitHub and see exactly how it works, no black boxes.',
  },
  {
    href: 'https://ymerflow.org',
    icon: 'fas fa-file-lines',
    text: 'Read the docs to get a feel for the architecture and what it can do for you.',
  },
  {
    href: 'https://ymerflow.org/docs/deployment.html',
    icon: 'fab fa-kubernetes',
    text: 'Spin it up yourself on a laptop with Minikube and put it to the test on your own data before you commit to anything.',
  },
];

function OpenSourceCard() {
  return (
    <Card className="h-100">
      <div className="card-header py-3">
        <h4 className="my-0 fw-normal">
          <i className="fas fa-code-branch me-2" aria-hidden="true"></i>
          Open Source
        </h4>
      </div>
      <Card.Body>
        <p>YmerFlow is free and open source. Try it out for yourself, no strings attached.</p>
        <ul className="list-unstyled">
          {OPEN_SOURCE_LINKS.map(({ href, icon, text }) => (
            <li key={href} className="mb-3">
              <a href={href} target="_blank" rel="noopener noreferrer" className="open-source-link">
                <i className={`${icon} me-3`} aria-hidden="true"></i>
                <span>{text}</span>
              </a>
            </li>
          ))}
        </ul>
      </Card.Body>
    </Card>
  );
}
