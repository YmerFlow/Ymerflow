from setuptools import setup, find_packages

setup(
    name='test-frontend-plugin',
    version='0.1.0',
    packages=find_packages(),
    package_data={'test_frontend_plugin': ['frontend_dist/**/*', 'frontend_dist/*']},
    include_package_data=True,
    entry_points={
        'ymerflow.hooks': [
            'frontend_bundles = test_frontend_plugin:frontend_bundles',
        ],
    },
)
