"""
Setup script for stack cloudformation-ne1y5vgir (api-and-observability).
Creates a CFN stack with subnets and security groups, then creates ENIs in the
*parent* stack's public subnets that reference a security group from the nested
stack. When the nested stack tries to delete, the SG deletion fails because
external ENIs still reference it.
"""

import json
import sys
import time
from typing import Optional

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

config = Config(connect_timeout=5, read_timeout=60)

REGION = "us-west-2"
STACK_NAME = "api-and-observability-cloudformation-ne1y5vgir-us-west-2"
NESTED_STACK_NAME = "danube-eks-cluster-b2e91c74"

NESTED_STACK_TEMPLATE = """\
AWSTemplateFormatVersion: '2010-09-09'
Description: EKS cluster networking for danube-helm-mig environment
Parameters:
  VpcId:
    Type: String
  AvailabilityZone1:
    Type: String
  AvailabilityZone2:
    Type: String
Resources:
  EksPrivateSubnet1:
    Type: AWS::EC2::Subnet
    Properties:
      VpcId: !Ref VpcId
      CidrBlock: 10.0.10.0/24
      AvailabilityZone: !Ref AvailabilityZone1
      Tags:
        - Key: Name
          Value: eks-private-subnet-1
  EksPrivateSubnet4:
    Type: AWS::EC2::Subnet
    Properties:
      VpcId: !Ref VpcId
      CidrBlock: 10.0.11.0/24
      AvailabilityZone: !Ref AvailabilityZone2
      Tags:
        - Key: Name
          Value: eks-private-subnet-4
  EksClusterSecurityGroup:
    Type: AWS::EC2::SecurityGroup
    Properties:
      GroupDescription: EKS cluster primary security group
      VpcId: !Ref VpcId
      Tags:
        - Key: Name
          Value: eks-cluster-sg
  WorkerNodeSecurityGroup:
    Type: AWS::EC2::SecurityGroup
    Properties:
      GroupDescription: Security group for EKS worker nodes
      VpcId: !Ref VpcId
      SecurityGroupIngress:
        - IpProtocol: tcp
          FromPort: 443
          ToPort: 443
          SourceSecurityGroupId: !Ref EksClusterSecurityGroup
      Tags:
        - Key: Name
          Value: eks-worker-node-sg
  PrivateRouteTable:
    Type: AWS::EC2::RouteTable
    Properties:
      VpcId: !Ref VpcId
      Tags:
        - Key: Name
          Value: eks-private-rt
  Subnet1RouteTableAssoc:
    Type: AWS::EC2::SubnetRouteTableAssociation
    Properties:
      SubnetId: !Ref EksPrivateSubnet1
      RouteTableId: !Ref PrivateRouteTable
  Subnet4RouteTableAssoc:
    Type: AWS::EC2::SubnetRouteTableAssociation
    Properties:
      SubnetId: !Ref EksPrivateSubnet4
      RouteTableId: !Ref PrivateRouteTable
Outputs:
  Subnet1Id:
    Value: !Ref EksPrivateSubnet1
  Subnet4Id:
    Value: !Ref EksPrivateSubnet4
  EksClusterSecurityGroupId:
    Value: !Ref EksClusterSecurityGroup
  WorkerNodeSecurityGroupId:
    Value: !Ref WorkerNodeSecurityGroup
"""

# ENIs placed in the parent stack's PUBLIC subnets, referencing the nested
# stack's WorkerNodeSecurityGroup. This creates a cross-stack dependency that
# blocks SG deletion.
ENI_SPECS = [
    (
        "AWS Lambda VPC ENI-4a8b2c1d-e5f6-7890-abcd-1234567890ab",
        "lambda-vpc-eni-prod-ingest",
    ),
    ("ECS eni-provision-task-8f3a", "ecs-task-eni-worker-pool"),
    (
        "AWS Lambda VPC ENI-9c7d3e2f-a1b2-3456-cdef-abcdef012345",
        "lambda-vpc-eni-prod-notify",
    ),
]


def _get_stack_outputs(cfn, stack_name):
    return {
        o["OutputKey"]: o["OutputValue"]
        for o in cfn.describe_stacks(StackName=stack_name)["Stacks"][0].get(
            "Outputs", []
        )
    }


def _create_nested_stack(cfn, vpc_id, az1, az2):
    """Create the nested stack and return its outputs, or None if already DELETE_FAILED."""
    try:
        resp = cfn.describe_stacks(StackName=NESTED_STACK_NAME)
        status = resp["Stacks"][0]["StackStatus"]
        print(f"Nested stack already exists: {status}")
        if status == "DELETE_FAILED":
            return None
        return _get_stack_outputs(cfn, NESTED_STACK_NAME)
    except ClientError as e:
        if "does not exist" not in str(e):
            raise

    print(f"Creating nested stack {NESTED_STACK_NAME}")
    cfn.create_stack(
        StackName=NESTED_STACK_NAME,
        TemplateBody=NESTED_STACK_TEMPLATE,
        Parameters=[
            {"ParameterKey": "VpcId", "ParameterValue": vpc_id},
            {"ParameterKey": "AvailabilityZone1", "ParameterValue": az1},
            {"ParameterKey": "AvailabilityZone2", "ParameterValue": az2},
        ],
        DisableRollback=True,
    )
    cfn.get_waiter("stack_create_complete").wait(
        StackName=NESTED_STACK_NAME, WaiterConfig={"Delay": 10, "MaxAttempts": 60}
    )
    return _get_stack_outputs(cfn, NESTED_STACK_NAME)


def _ensure_enis(ec2, public_subnet_ids, worker_sg_id):
    """Create ENIs in the parent stack's public subnets referencing the nested stack's SG."""
    existing = ec2.describe_network_interfaces(
        Filters=[
            {"Name": "subnet-id", "Values": public_subnet_ids},
            {"Name": "group-id", "Values": [worker_sg_id]},
        ]
    )["NetworkInterfaces"]
    existing_descs = {eni["Description"] for eni in existing}

    for i, (desc, name) in enumerate(ENI_SPECS):
        if desc in existing_descs:
            continue
        subnet_id = public_subnet_ids[i % len(public_subnet_ids)]
        print(f"Creating ENI: {name} in {subnet_id}")
        ec2.create_network_interface(
            SubnetId=subnet_id,
            Groups=[worker_sg_id],
            Description=desc,
            TagSpecifications=[
                {
                    "ResourceType": "network-interface",
                    "Tags": [{"Key": "Name", "Value": name}],
                }
            ],
        )
    print("All ENIs present")


def _trigger_delete_and_wait(cfn):
    """Initiate stack deletion and wait for DELETE_FAILED."""
    status = cfn.describe_stacks(StackName=NESTED_STACK_NAME)["Stacks"][0][
        "StackStatus"
    ]
    if status == "DELETE_FAILED":
        return True
    if status != "DELETE_IN_PROGRESS":
        print(f"Initiating stack deletion for {NESTED_STACK_NAME}")
        cfn.delete_stack(StackName=NESTED_STACK_NAME)

    print("Waiting for DELETE_FAILED (can take ~20 minutes)...")
    for _ in range(120):
        time.sleep(10)
        try:
            status = cfn.describe_stacks(StackName=NESTED_STACK_NAME)["Stacks"][0][
                "StackStatus"
            ]
            print(f"Stack status: {status}")
            if status == "DELETE_FAILED":
                return True
        except ClientError as e:
            if "does not exist" in str(e):
                print("Stack deleted successfully (unexpected)", file=sys.stderr)
                return False
            raise

    print("Timed out waiting for DELETE_FAILED", file=sys.stderr)
    return False


def run(session: Optional[boto3.Session] = None, region: str = REGION, **parameters):
    if session is None:
        session = boto3.Session(profile_name="PRIMARY")

    cfn = session.client("cloudformation", config=config, region_name=region)
    ec2 = session.client("ec2", config=config, region_name=region)

    parent_outputs = _get_stack_outputs(cfn, STACK_NAME)
    vpc_id = parent_outputs["VpcId"]
    public_subnet_ids = [
        parent_outputs["PublicSubnet1Id"],
        parent_outputs["PublicSubnet2Id"],
    ]

    azs = ec2.describe_availability_zones(
        Filters=[{"Name": "state", "Values": ["available"]}]
    )["AvailabilityZones"]

    nested_outputs = _create_nested_stack(
        cfn,
        vpc_id,
        az1=azs[0]["ZoneName"],
        az2=azs[1]["ZoneName"],
    )

    if nested_outputs is None:
        return {"success": True, "output_values": None}

    worker_sg_id = nested_outputs["WorkerNodeSecurityGroupId"]
    _ensure_enis(ec2, public_subnet_ids, worker_sg_id)

    success = _trigger_delete_and_wait(cfn)
    return {"success": success, "output_values": None}


if __name__ == "__main__":
    try:
        result = run()
        print(json.dumps(result, indent=2))
        if isinstance(result, dict) and not result.get("success", True):
            sys.exit(1)
    except Exception as e:
        print(f"Setup failed: {e}", file=sys.stderr)
        sys.exit(1)
